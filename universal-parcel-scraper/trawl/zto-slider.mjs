export async function solveSlider() {
  const bg = document.querySelector('.dx_captcha_basic_bg canvas');
  const sub = document.querySelector('.dx_captcha_basic_sub-slider');
  const img = sub?.querySelector('img');
  const slider = document.querySelector('.dx_captcha_basic_slider');
  if (!bg || !img || !slider || !bg.getBoundingClientRect().width) return { error: 'no-slider' };
  const r = bg.getBoundingClientRect(), ir = img.getBoundingClientRect();
  if (bg.width > 800 || bg.height > 400 || ir.width > 120 || ir.height > 120) return { error: 'unexpected-image' };
  const scale = bg.width / r.width;
  const image = new Image(); image.crossOrigin = 'anonymous'; image.src = img.src;
  await image.decode();
  const c = document.createElement('canvas');
  c.width = Math.round(ir.width * scale); c.height = Math.round(ir.height * scale);
  c.getContext('2d').drawImage(image, 0, 0, c.width, c.height);
  const a = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const b = bg.getContext('2d').getImageData(0, 0, bg.width, bg.height).data;
  const n = c.width * c.height, mask = new Uint8Array(n);
  let sumA = 0;
  for (let i = 0; i < n; i++) sumA += mask[i] = a[i * 4 + 3] > 180 ? 1 : 0;
  const meanA = sumA / n, varA = sumA * (1 - meanA);
  const gray = new Uint8Array(bg.width * bg.height);
  for (let i = 0; i < gray.length; i++) gray[i] = (b[i*4] * 0.299 + b[i*4+1] * 0.587 + b[i*4+2] * 0.114);
  const expectedY = Math.round((ir.y - r.y) * scale);
  let best = { score: -1, x: 0, y: 0, threshold: 0 };
  // Row runs replace a per-pixel dot product at every candidate position.
  // Prefix sums preserve the same binary correlation while bounding CPU work.
  const stride = bg.width + 1, runs = [];
  for (let dy = 0; dy < c.height; dy++) {
    for (let dx = 0; dx < c.width;) {
      if (!mask[dy * c.width + dx]) { dx++; continue; }
      const left = dx;
      while (dx < c.width && mask[dy * c.width + dx]) dx++;
      runs.push([dy * stride + left, dy * stride + dx]);
    }
  }
  for (const threshold of [70, 110, 150, 190]) {
    const rows = new Uint32Array(stride * bg.height);
    const integral = new Uint32Array(stride * (bg.height + 1));
    for (let y = 0; y < bg.height; y++) {
      let sum = 0;
      for (let x = 0; x < bg.width; x++) {
        sum += gray[y * bg.width + x] < threshold ? 1 : 0;
        rows[y * stride + x + 1] = sum;
        integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + sum;
      }
    }
    for (let y = Math.max(0, expectedY - 12); y <= Math.min(bg.height - c.height, expectedY + 12); y++) {
      for (let x = Math.round(65 * scale); x < bg.width - c.width; x++) {
        const origin = y * stride + x, bottom = origin + c.height * stride;
        const sumB = integral[bottom + c.width] - integral[bottom] - integral[origin + c.width] + integral[origin];
        let sumAB = 0;
        for (const [left, right] of runs) sumAB += rows[origin + right] - rows[origin + left];
        const varB = sumB * (1 - sumB / n);
        const score = varB > 0 ? (sumAB - sumB * meanA) / Math.sqrt(varA * varB) : -1;
        if (score > best.score) best = { score, x, y, threshold };
      }
    }
  }
  // Outline-only pieces keep the underlying photo. Match the alpha boundary
  // against strong grayscale edges when solid-dark matching is inconclusive.
  if (best.score < 0.6) {
    const edge = new Uint8Array(gray.length), dist = new Float32Array(gray.length).fill(10);
    for (let y=1;y<bg.height-1;y++) for(let x=1;x<bg.width-1;x++) {
      const i=y*bg.width+x;
      const gx=-gray[i-bg.width-1]-2*gray[i-1]-gray[i+bg.width-1]+gray[i-bg.width+1]+2*gray[i+1]+gray[i+bg.width+1];
      const gy=-gray[i-bg.width-1]-2*gray[i-bg.width]-gray[i-bg.width+1]+gray[i+bg.width-1]+2*gray[i+bg.width]+gray[i+bg.width+1];
      if(Math.hypot(gx,gy)>180) { edge[i]=1; dist[i]=0; }
    }
    for(let y=1;y<bg.height;y++)for(let x=1;x<bg.width;x++){const i=y*bg.width+x;dist[i]=Math.min(dist[i],dist[i-1]+1,dist[i-bg.width]+1,dist[i-bg.width-1]+1.414)}
    for(let y=bg.height-2;y>=0;y--)for(let x=bg.width-2;x>=0;x--){const i=y*bg.width+x;dist[i]=Math.min(dist[i],dist[i+1]+1,dist[i+bg.width]+1,dist[i+bg.width+1]+1.414)}
    const outline=[];
    for(let y=1;y<c.height-1;y++)for(let x=1;x<c.width-1;x++){const i=y*c.width+x;if(mask[i]&&(!mask[i-1]||!mask[i+1]||!mask[i-c.width]||!mask[i+c.width]))outline.push([x,y])}
    let match={cost:10,x:0,y:0};
    for(let y=Math.max(0,expectedY-12);y<=Math.min(bg.height-c.height,expectedY+12);y++)for(let x=Math.round(65*scale);x<bg.width-c.width;x++){
      let cost=0;for(const [dx,dy] of outline)cost+=dist[(y+dy)*bg.width+x+dx];cost/=outline.length;
      if(cost<match.cost)match={cost,x,y};
    }
    if(match.cost<1.4)best={...best,x:match.x,y:match.y,score:1-match.cost/4,method:'outline',cost:match.cost};
  }
  const s = slider.getBoundingClientRect();
  return { ...best, distance: best.x/scale-(ir.x-r.x), start: {x:s.x+s.width/2,y:s.y+s.height/2}, size:{width:c.width,height:c.height}, expectedY };
}
