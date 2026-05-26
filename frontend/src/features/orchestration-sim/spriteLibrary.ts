import type { SpriteDefinition } from './types'

export const spriteLibrary: Record<string, SpriteDefinition> = {
  // ── coderBlue ── yellow hair, blue shirt, dark navy pants ──────────────────
  coderBlue: {
    id: 'coderBlue',
    pixels: [
      '..HH..',  // hair top
      '.HFFH.',  // hair sides + skin face
      '.FEEF.',  // face + dark eyes
      '.FMMF.',  // face + small mouth
      '..FF..',  // neck
      '.BBBB.',  // blue shirt torso
      'B.BB.B',  // shirt + arms
      'LL..LL',  // pants / legs
    ],
    palette: {
      '.': 'transparent',
      H: '#fde047',  // yellow hair
      F: '#fcd7b0',  // skin
      E: '#1e293b',  // eyes
      M: '#c47070',  // mouth
      B: '#3b82f6',  // blue shirt
      L: '#1e3a5f',  // dark navy pants
    },
  },

  // ── plannerGreen ── brown hair, green shirt, dark pants ────────────────────
  plannerGreen: {
    id: 'plannerGreen',
    pixels: [
      '..HH..',
      '.HFFH.',
      '.FEEF.',
      '.FMMF.',
      '..FF..',
      '.GGGG.',
      'G.GG.G',
      'LL..LL',
    ],
    palette: {
      '.': 'transparent',
      H: '#92400e',  // brown hair
      F: '#fcd7b0',  // skin
      E: '#1e293b',  // eyes
      M: '#c47070',  // mouth
      G: '#22c55e',  // green shirt
      L: '#14532d',  // dark green pants
    },
  },

  // ── reviewerPurple ── dark hair (wider), purple shirt, indigo pants ─────────
  reviewerPurple: {
    id: 'reviewerPurple',
    pixels: [
      '.HHHH.',  // wider dark hair
      'HFFFFH',  // hair sides + face
      '.FEEF.',
      '.FMMF.',
      '..FF..',
      '.PPPP.',
      'P.PP.P',
      'LL..LL',
    ],
    palette: {
      '.': 'transparent',
      H: '#1e293b',  // dark hair
      F: '#fcd7b0',  // skin
      E: '#312e81',  // dark indigo eyes
      M: '#c47070',  // mouth
      P: '#8b5cf6',  // purple shirt
      L: '#312e81',  // indigo pants
    },
  },
}
