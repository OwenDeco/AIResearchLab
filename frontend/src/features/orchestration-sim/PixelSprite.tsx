import type { SpriteDefinition } from './types'

type PixelSpriteProps = {
  sprite: SpriteDefinition
  size?: number
}

export function PixelSprite({ sprite, size = 4 }: PixelSpriteProps) {
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: `repeat(${sprite.pixels[0].length}, ${size}px)`,
        gridAutoRows: `${size}px`,
        imageRendering: 'pixelated',
      }}
      aria-label={`${sprite.id} sprite`}
    >
      {sprite.pixels.flatMap((row, y) =>
        row.split('').map((pixel, x) => (
          <div
            key={`${x}-${y}`}
            style={{
              width: size,
              height: size,
              backgroundColor: sprite.palette[pixel] ?? 'transparent',
            }}
          />
        )),
      )}
    </div>
  )
}
