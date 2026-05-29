import { Effect, Stream } from "effect"

export const readBoundedText = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  maxBytes: number,
  label: string,
): Effect.Effect<string, E | Error, R> => stream.pipe(
  Stream.runFoldEffect(
    () => ({ chunks: [] as Array<Uint8Array>, size: 0 }),
    (collected, chunk) => {
      const size = collected.size + chunk.byteLength
      if (size > maxBytes) return Effect.fail(new Error(`${label} exceeds ${maxBytes} bytes.`))
      collected.chunks.push(chunk)
      return Effect.succeed({ chunks: collected.chunks, size })
    },
  ),
  Effect.map((collected) => {
    const bytes = new Uint8Array(collected.size)
    let offset = 0
    for (const chunk of collected.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
  }),
)
