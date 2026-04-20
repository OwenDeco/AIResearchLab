import type { SpriteDefinition } from './types'

export const spriteLibrary: Record<string, SpriteDefinition> = {
  coderBlue: {
    id: 'coderBlue',
    pixels: [
      '..YY..',
      '.YSSY.',
      '.YGGY.',
      '.BBBB.',
      '.BMMB.',
      'B....B',
    ],
    palette: {
      '.': 'transparent',
      Y: '#fde047',
      S: '#334155',
      G: '#f8fafc',
      B: '#3b82f6',
      M: '#93c5fd',
    },
  },
  plannerGreen: {
    id: 'plannerGreen',
    pixels: [
      '..YY..',
      '.YSSY.',
      '.YGGY.',
      '.GGGG.',
      '.GMMG.',
      'G....G',
    ],
    palette: {
      '.': 'transparent',
      Y: '#facc15',
      S: '#1f2937',
      G: '#22c55e',
      M: '#bbf7d0',
    },
  },
  reviewerPurple: {
    id: 'reviewerPurple',
    pixels: [
      '..YY..',
      '.YSSY.',
      '.YGGY.',
      '.PPPP.',
      '.PMMP.',
      'P....P',
    ],
    palette: {
      '.': 'transparent',
      Y: '#fde047',
      S: '#312e81',
      G: '#f8fafc',
      P: '#8b5cf6',
      M: '#ddd6fe',
    },
  },
}
