const FACES = ['400 14px "Public Sans"', '500 14px "Public Sans"', '600 14px "Public Sans"'];

/**
 * Best effort: a font that is slow, missing or fails to load must not block drawing. Never rejects, and
 * never leaves its timer running.
 */
export async function loadFonts(fonts: { load(face: string): Promise<unknown> }, timeoutMs = 3000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.all(FACES.map((f) => fonts.load(f).catch(() => []))), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
