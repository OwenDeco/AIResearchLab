from config import settings
from models.openai_provider import OpenAIEmbedding

api_key = settings.OPENAI_API_KEY
models_to_try = [
    "text-embedding-3-small",
    "text-embedding-3-large",
    "text-embedding-ada-002",
]

for model in models_to_try:
    try:
        embedder = OpenAIEmbedding(model=model, api_key=api_key)
        result = embedder.embed(["test sentence"])
        print(f"OK: {model} -> dim={len(result[0])}")
    except Exception as e:
        print(f"FAIL: {model} -> {e}")
