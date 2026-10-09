/** What a masked secret value is replaced with. */
export const SECRET_MASK = "***";

/**
 * Values shorter than this are not masked: a three-character value like
 * `abc` or `123` would turn ordinary output into stars.
 */
export const MIN_MASKED_LENGTH = 4;

/**
 * Replaces secret values in a stream of output with `***`, including a value
 * split across two chunks. It holds back only the end of a chunk that could
 * still be the start of a value, so output is not delayed otherwise.
 *
 * Simple on purpose: it catches a tool printing a value as it is, not an
 * encoded or reformatted one.
 */
export class SecretMasker {
  private readonly values: Buffer[];
  private readonly mask = Buffer.from(SECRET_MASK);
  private carry: Buffer = Buffer.alloc(0);

  constructor(values: Iterable<string>) {
    this.values = [...new Set(values)]
      .filter((value) => value.length >= MIN_MASKED_LENGTH)
      .map((value) => Buffer.from(value, "utf8"))
      // Longest first, so a value that contains another is masked whole.
      .sort((left, right) => right.length - left.length);
  }

  /** The masked output this chunk makes ready; the rest waits for more. */
  push(chunk: Uint8Array): Buffer {
    if (this.values.length === 0) return Buffer.from(chunk);
    return this.scan(Buffer.concat([this.carry, chunk]), false);
  }

  /** Whatever was held back, masked, once the stream has ended. */
  flush(): Buffer {
    return this.scan(this.carry, true);
  }

  /**
   * Masks `buffer`. Unless `final`, it stops where the rest could still be
   * the start of a value and keeps that rest for the next chunk.
   */
  private scan(buffer: Buffer, final: boolean): Buffer {
    const parts: Buffer[] = [];
    let start = 0;
    let index = 0;
    scan: while (index < buffer.length) {
      for (const value of this.values) {
        if (buffer[index] !== value[0]) continue;
        const available = buffer.length - index;
        if (available >= value.length) {
          if (
            buffer.compare(
              value,
              0,
              value.length,
              index,
              index + value.length,
            ) !== 0
          )
            continue;
          parts.push(buffer.subarray(start, index), this.mask);
          index += value.length;
          start = index;
          continue scan;
        }
        // The chunk ends partway into what may be this value.
        if (
          !final &&
          buffer.compare(value, 0, available, index, buffer.length) === 0
        )
          break scan;
      }
      index += 1;
    }
    parts.push(buffer.subarray(start, index));
    this.carry = Buffer.from(buffer.subarray(index));
    return Buffer.concat(parts);
  }
}
