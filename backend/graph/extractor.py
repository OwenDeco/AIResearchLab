from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import List, Optional

from models.base import LLMProvider

logger = logging.getLogger(__name__)

_DEFAULT_ENTITY_TYPES = ["Person", "Organization", "Technology", "Concept", "Location", "Other"]

# ---------------------------------------------------------------------------
# Allowed predicates — strong, unambiguous relations only.
# This list is the canonical default; users can enable/disable individual
# predicates via the Graph Explorer configuration panel.
# ---------------------------------------------------------------------------

ALLOWED_PREDICATES = [
    "is_a",              # X is a type / kind of Y
    "part_of",           # X is a component or member of Y
    "uses",              # X employs / uses Y
    "created_by",        # X was created / authored / developed by Y
    "located_in",        # X is located / headquartered in Y
    "works_for",         # person X works for / is employed by Y
    "depends_on",        # X requires / depends on Y
    "implements",        # X implements / applies Y
    "based_on",          # X is derived from / based on Y
    "causes",            # X causes / leads to / results in Y
    "evaluates",         # X measures / evaluates / benchmarks Y
    "collaborates_with", # X works together with Y
]

_DEFAULT_MIN_CONFIDENCE = 0.65
_MIN_RELATED_TO_CONFIDENCE = 0.85  # "related_to" only kept if very confident

_EXTRACT_PROMPT = """\
You are a knowledge graph extraction engine. Extract specific named entities \
and well-evidenced relationships from the text below.

STRICT RULES:
- Entities must be specific and named (e.g. "BERT", "OpenAI", "Paris").
  Do NOT extract generic nouns like "model", "data", "system", "approach".
- Entity types must be one of: {entity_types}
- Predicates must be exactly one of: {predicates}
- Only extract relations explicitly stated in the text — no inferences.
- confidence: 0.0–1.0 based on how clearly the relation is stated in the text.
- evidence: a verbatim quote (≤ 15 words) from the text that supports the relation.

Return ONLY a valid JSON array. Each element:
{{
  "subject": "...",
  "subject_type": "...",
  "predicate": "...",
  "object": "...",
  "object_type": "...",
  "confidence": 0.85,
  "evidence": "exact short quote from text"
}}

If no strong relationships are found, return an empty array [].

Text:
{text}

JSON:"""


def preprocess_for_extraction(text: str) -> str:
    """Light cleanup before sending text to the LLM extractor.

    - Strip HTML/XML tags
    - Normalize Unicode dashes and quotes
    - Collapse repeated blank lines and excess whitespace
    """
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("\u2013", "-").replace("\u2014", "-")
    text = text.replace("\u2018", "'").replace("\u2019", "'")
    text = text.replace("\u201c", '"').replace("\u201d", '"')
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[^\S\n]+", " ", text)
    return text.strip()


@dataclass
class Triple:
    subject: str
    subject_type: str
    predicate: str
    object_: str
    object_type: str
    chunk_id: str
    doc_id: str
    confidence: float = 1.0
    evidence: str = ""


class EntityRelationExtractor:
    """
    LLM-powered entity/relation extractor.

    Returns typed, confidence-scored triples with evidence quotes.
    Filters out vague/weak relations below the confidence threshold.

    All extraction parameters (entity types, allowed predicates, confidence
    threshold, preprocessing) are configurable and loaded from AppState at
    the start of each extraction run.
    """

    def __init__(
        self,
        llm: LLMProvider,
        entity_types: Optional[List[str]] = None,
        allowed_predicates: Optional[List[str]] = None,
        min_confidence: float = _DEFAULT_MIN_CONFIDENCE,
        preprocess_text: bool = True,
    ) -> None:
        self._llm = llm
        self._entity_types = entity_types or _DEFAULT_ENTITY_TYPES
        self._allowed_predicates = allowed_predicates or ALLOWED_PREDICATES
        self._min_confidence = min_confidence
        self._preprocess_text = preprocess_text

    def extract(self, text: str, chunk_id: str, doc_id: str) -> List[Triple]:
        """
        Extract entity–relation triples from *text*.
        Returns an empty list on any failure rather than raising
        (except rate-limit errors, which are re-raised so the pipeline
        can apply its global backoff and retry).
        """
        if self._preprocess_text:
            text = preprocess_for_extraction(text)

        prompt = _EXTRACT_PROMPT.format(
            entity_types=", ".join(self._entity_types),
            predicates=", ".join(self._allowed_predicates),
            text=text[:3000],
        )

        try:
            response = self._llm.complete(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=1024,
            )
            raw = response.content.strip()
        except Exception as exc:
            # Re-raise rate limit errors so the pipeline can apply its global
            # backoff and retry the chunk — swallowing them would silently drop data.
            exc_name = type(exc).__name__
            if "RateLimit" in exc_name or "rate_limit" in str(exc).lower() or "429" in str(exc):
                raise
            logger.warning("EntityRelationExtractor: LLM call failed: %s", exc)
            return []

        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = "\n".join(
                line for line in raw.split("\n") if not line.startswith("```")
            ).strip()

        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            start, end = raw.find("["), raw.rfind("]")
            if start != -1 and end > start:
                try:
                    data = json.loads(raw[start:end + 1])
                except json.JSONDecodeError:
                    logger.debug("EntityRelationExtractor: could not parse JSON for chunk %s", chunk_id)
                    return []
            else:
                logger.debug("EntityRelationExtractor: no JSON array in response for chunk %s", chunk_id)
                return []

        if not isinstance(data, list):
            return []

        triples: List[Triple] = []
        for item in data:
            if not isinstance(item, dict):
                continue

            subject = str(item.get("subject", "")).strip()
            object_ = str(item.get("object", "")).strip()
            if not subject or not object_:
                continue

            predicate = str(item.get("predicate", "")).strip().lower().replace(" ", "_")
            if predicate not in self._allowed_predicates:
                logger.debug(
                    "EntityRelationExtractor: skipping unknown predicate '%s' in chunk %s",
                    predicate, chunk_id,
                )
                continue

            try:
                confidence = float(item.get("confidence", 0.0))
            except (TypeError, ValueError):
                confidence = 0.0

            threshold = (
                _MIN_RELATED_TO_CONFIDENCE
                if predicate == "related_to"
                else self._min_confidence
            )
            if confidence < threshold:
                logger.debug(
                    "EntityRelationExtractor: dropped low-confidence triple (%.2f < %.2f): %s -[%s]-> %s",
                    confidence, threshold, subject, predicate, object_,
                )
                continue

            triples.append(
                Triple(
                    subject=subject,
                    subject_type=str(item.get("subject_type", "Other")).strip(),
                    predicate=predicate,
                    object_=object_,
                    object_type=str(item.get("object_type", "Other")).strip(),
                    chunk_id=chunk_id,
                    doc_id=doc_id,
                    confidence=round(confidence, 3),
                    evidence=str(item.get("evidence", "")).strip()[:200],
                )
            )

        logger.debug(
            "EntityRelationExtractor: %d triples extracted (after filtering) from chunk %s",
            len(triples), chunk_id,
        )
        return triples
