interface Pixels { width: number; height: number; data: Uint8Array }

/** Match the transparent tile's interior against its darkened slot in native image pixels. */
export function depponPuzzleOffset(background: Pixels, piece: Pixels): number | null {
  if (background.width !== 310 || background.height !== 155 || piece.height !== 155 || piece.width < 20 || piece.width > 60
    || background.data.length !== 310 * 155 * 4 || piece.data.length !== piece.width * 155 * 4) return null;
  const samples: { x: number; y: number; rgb: number[] }[] = [];
  for (let y = 2; y < piece.height - 2; y++) for (let x = 2; x < piece.width - 2; x++) {
    let opaque = true;
    for (let dy = -2; dy <= 2 && opaque; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (piece.data[((y + dy) * piece.width + x + dx) * 4 + 3]! < 250) { opaque = false; break; }
    }
    if (opaque) {
      const offset = (y * piece.width + x) * 4;
      samples.push({ x, y, rgb: [piece.data[offset]!, piece.data[offset + 1]!, piece.data[offset + 2]!] });
    }
  }
  if (samples.length < 100 || samples.length > 2500) return null;
  const average = samples.reduce((sum, sample) => sum + sample.rgb.reduce((sum, value) => sum + value, 0), 0) / (3 * samples.length);
  const energy = samples.reduce((sum, sample) => sum + sample.rgb.reduce((sum, value) => sum + (value - average) ** 2, 0), 0);
  if (energy / (samples.length * 3) < 50) return null;
  const scores: { x: number; score: number }[] = [];
  for (let x = 30; x <= background.width - piece.width; x++) {
    const averageBackground = samples.reduce((sum, sample) => {
      const offset = (sample.y * background.width + x + sample.x) * 4;
      return sum + background.data[offset]! + background.data[offset + 1]! + background.data[offset + 2]!;
    }, 0) / (3 * samples.length);
    let product = 0, energyBackground = 0;
    for (const sample of samples) {
      const offset = (sample.y * background.width + x + sample.x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const a = sample.rgb[channel]! - average, b = background.data[offset + channel]! - averageBackground;
        product += a * b; energyBackground += b * b;
      }
    }
    scores.push({ x, score: product / Math.sqrt(energy * energyBackground) });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0], other = best && scores.find(score => Math.abs(score.x - best.x) > 8);
  return best && other && best.score >= .9 && best.score - other.score >= .08 ? best.x : null;
}
