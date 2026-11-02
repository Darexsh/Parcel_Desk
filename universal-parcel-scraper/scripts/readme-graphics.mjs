/*
 * The README's pictures, as SVG strings. scripts/generate-readme.mjs feeds them the
 * repository's data and writes them to docs/assets.
 */
const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Every picture is a card with its own surface, so it reads the same on any page theme.
export const theme = { surface: '#171714', edge: '#3a382e', ink: '#fffaf0', muted: '#b5b1a3', line: '#3a382e', box: '#23221c', accent: '#f3cf48', tint: '#4d4113', other: '#6b6859' };
const card = (width, height, label, style, body) => [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width + 56} ${height + 52}" role="img" aria-label="${label}">`,
  `  <style>${style}</style>`,
  `  <rect x=".5" y=".5" width="${width + 55}" height="${height + 51}" rx="12" fill="${theme.surface}" stroke="${theme.edge}"/>`,
  '  <g transform="translate(28 26)">', ...body, '  </g>', '</svg>', '',
].join('\n');

/** Carriers with history per source, as bars. `rows` are `{ label, count, own }`. */
export function coverageChart(rows, total) {
  const left = 270, scale = 420, pitch = 34, top = 44, bottom = top + rows.length * pitch;
  const at = count => Math.round(left + count / total * scale);
  const bar = (row, index) => {
    const y = top + index * pitch + 8, width = Math.max(8, at(row.count) - left);
    return [
      `  <text x="0" y="${y + 13.5}" fill="${theme.ink}"${row.own ? ' font-weight="600"' : ''}>${row.label}</text>`,
      `  <path d="M${left} ${y}h${width - 4}a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4h-${width - 4}z" fill="${row.own ? theme.accent : theme.other}"/>`,
      `  <text x="${left + width + 8}" y="${y + 13.5}" fill="${theme.ink}"${row.own ? ' font-weight="600"' : ''}>${row.count}</text>`,
    ].join('\n');
  };
  const ticks = [0, total / 2, total];
  return card(760, bottom + 24, 'Carriers with tracking history, by source', `text { font: 13px ${sans}; }`, [
    `  <text x="0" y="16" fill="${theme.muted}">Carriers with tracking history, out of ${total}</text>`,
    `  <rect x="${left + scale - 222}" y="6" width="10" height="10" rx="2" fill="${theme.accent}"/>`,
    `  <text x="${left + scale - 206}" y="16" fill="${theme.muted}">this project</text>`,
    `  <rect x="${left + scale - 118}" y="6" width="10" height="10" rx="2" fill="${theme.other}"/>`,
    `  <text x="${left + scale - 102}" y="16" fill="${theme.muted}">one source alone</text>`,
    ...ticks.map(tick => `  <path d="M${at(tick) + .5} ${top}V${bottom}" stroke="${theme.line}"/>`),
    ...rows.map(bar),
    ...ticks.map(tick => `  <text x="${at(tick)}" y="${bottom + 20}" fill="${theme.muted}" text-anchor="middle" style="font-size: 11.5px">${tick}</text>`),
  ]);
}

/** Recorded statuses of several carriers meeting in one stage, above the whole stage list. `samples` are `{ carrier, label, code }`. */
export function stagesFigure(samples, stage, stages) {
  const width = 760, chip = 500, pillLeft = 586, pitch = 40, rowHeight = 32;
  const middle = (samples.length * pitch - 8) / 2;
  const pill = (x, y, name) => {
    const own = name === stage, wide = Math.round(name.length * 7.3 + 22);
    return { wide, svg: [
      `  <rect x="${x + .5}" y="${y + .5}" width="${wide}" height="25" rx="13" fill="${own ? theme.tint : theme.box}" stroke="${own ? theme.accent : theme.line}"/>`,
      `  <text class="mono" x="${x + wide / 2}" y="${y + 17}" text-anchor="middle" fill="${own ? theme.ink : theme.muted}">${name}</text>`,
    ].join('\n') };
  };
  const rows = samples.map((sample, index) => {
    const y = index * pitch, centre = y + rowHeight / 2;
    return [
      `  <path d="M${chip} ${centre}C${chip + 50} ${centre} ${pillLeft - 50} ${middle} ${pillLeft} ${middle}" fill="none" stroke="${theme.other}" stroke-width="1.5"/>`,
      `  <rect x=".5" y="${y + .5}" width="${chip - 1}" height="${rowHeight - 1}" rx="8" fill="${theme.box}" stroke="${theme.line}"/>`,
      `  <text x="14" y="${y + 20.5}" fill="${theme.muted}" style="font-size: 12px">${escape(sample.carrier)}</text>`,
      `  <text${sample.code ? ' class="mono"' : ''} x="156" y="${y + 20.5}" fill="${theme.ink}">${escape(sample.label)}</text>`,
    ].join('\n');
  });
  const target = [
    `  <rect x="${pillLeft + .5}" y="${middle - 18.5}" width="${width - pillLeft - 1}" height="37" rx="18.5" fill="${theme.tint}" stroke="${theme.accent}"/>`,
    `  <text class="mono" x="${(pillLeft + width) / 2}" y="${middle + 4.5}" text-anchor="middle" fill="${theme.ink}" style="font-size: 13px">${stage}</text>`,
  ].join('\n');
  // The whole vocabulary, wrapped onto as many lines as it needs.
  let x = 0, y = samples.length * pitch + 34;
  const list = [`  <text x="0" y="${y - 12}" fill="${theme.muted}" style="font-size: 12px">Every stage a scan can be filed under</text>`];
  for (const name of stages) {
    let next = pill(x, y, name);
    if (x + next.wide > width) { x = 0; y += 33; next = pill(x, y, name); }
    list.push(next.svg);
    x += next.wide + 8;
  }
  return card(width, y + 26, `${samples.length} carriers' statuses filed under ${stage}`,
    `text { font: 13px ${sans}; } .mono { font: 12px ${mono}; }`, [...rows, target, ...list]);
}

const terminalInk = { window: '#171714', bar: '#23221c', edge: '#3a382e', text: '#b5b1a3', title: '#8c897c', command: '#fffaf0', prompt: '#f3cf48', key: '#e9dfc0', string: '#dcb98f' };
// What `track` printed for a parcel on its way, cut down to three fields by the jq filter in the picture.
const scans = [
  ['2026-03-14T07:42:00+01:00', 'out_for_delivery', 'Lausanne'],
  ['2026-03-13T22:10:00+01:00', 'in_transit', 'Daillens'],
  ['2026-03-13T16:05:00+01:00', 'accepted', 'Zürich'],
].map(([time, stage, location]) => JSON.stringify({ time, stage, location }));

/**
 * A terminal session: `detect` with the output passed in, then `track` piped through jq.
 * The commands type themselves and the output follows, on a loop. A viewer that plays no
 * animation, or asks for none, sees the finished session.
 */
export function terminal(detectCommand, detectOutput) {
  const width = 840, pad = 28, cell = 7.8, pitch = 21, bar = 40, loop = 18;
  // Every character sits on its own column, so the layout is the same in any monospace font.
  const column = index => String(Math.round((pad + index * cell) * 10) / 10);
  const place = (segments, start = 0) => {
    const spans = [];
    for (const [text, role] of segments) {
      for (const word of text.matchAll(/\S+/g)) {
        const columns = [...word[0]].map((_, index) => column(start + word.index + index)).join(' ');
        spans.push(`<tspan${role ? ` class="${role}"` : ''} x="${columns}">${escape(word[0])}</tspan>`);
      }
      start += [...text].length;
    }
    return spans.join('');
  };
  const json = line => [...line.matchAll(/("(?:[^"\\]|\\.)*")(\s*:)?|[^"]+/g)]
    .flatMap(([all, quoted, colon]) => quoted ? [[quoted, colon ? 'key' : 'string'], ...(colon ? [[colon, '']] : [])] : [[all, '']]);
  const shell = line => [...line.matchAll(/('[^']*'|"[^"]*")|(\||\\$)|[^'"|\\]+/g)]
    .map(([all, quoted, operator]) => [all, quoted ? 'string' : operator ? 'prompt' : 'command']);
  // When each row shows, in seconds into the loop; a typed row also says when its typing starts and how long it takes.
  const rows = [
    { prompt: true, typed: detectCommand, at: 0, from: .9, take: 1.9 },
    ...detectOutput.map(text => ({ text, at: 3.2 })),
    { gap: true },
    { prompt: true, typed: 'npx universal-parcel-scraper track "$NUMBER" \\', at: 3.6, from: 4.8, take: 1.6 },
    { indent: 4, typed: "| jq -c '.result.events[] | {time, stage, location}'", at: 6.4, from: 6.4, take: 1.8 },
    ...scans.map((text, index) => ({ text, at: 8.7 + index * .12 })),
    { gap: true },
    { prompt: true, cursor: true, at: 9.4 },
  ];
  const share = seconds => `${(seconds / loop * 100).toFixed(2)}%`;
  const motion = [], lines = [];
  let y = bar + 34;
  rows.forEach((row, index) => {
    if (row.gap) { y += pitch * .6; return; }
    const lead = row.prompt ? 2 : row.indent ?? 0;
    const shown = row.at > 0 ? ` class="show${index}"` : '';
    if (row.at > 0) motion.push(`.show${index} { animation: show${index} ${loop}s infinite; } @keyframes show${index} { 0%, ${share(row.at)} { opacity: 0; } ${share(row.at + .02)}, 100% { opacity: 1; } }`);
    if (row.prompt) lines.push(`<text${shown} y="${y}">${place([['$', 'prompt']])}</text>`);
    if (row.typed) {
      const length = [...row.typed].length, end = column(lead + length), run = Math.round(length * cell * 10) / 10;
      const next = rows.slice(index + 1).find(later => later.at !== undefined).at;
      lines.push(`<text y="${y}">${place(shell(row.typed), lead)}</text>`);
      // A cover in the window's colour slides off the command a character at a time, with the cursor on its edge.
      motion.push(`.type${index} { animation: type${index} ${loop}s infinite; } @keyframes type${index} { 0%, ${share(row.from)} { transform: translateX(-${run}px); animation-timing-function: steps(${length}, end); } ${share(row.from + row.take)}, 100% { transform: translateX(0); } }`);
      motion.push(`.caret${index} { animation: caret${index} ${loop}s infinite; } @keyframes caret${index} { 0%, ${share(row.at)} { opacity: 0; } ${share(row.at + .02)}, ${share(next)} { opacity: 1; } ${share(next + .02)}, 100% { opacity: 0; } }`);
      lines.push(`<g class="type${index}"><rect x="${end}" y="${y - 15}" width="${width}" height="${pitch}" fill="${terminalInk.window}"/><rect class="caret${index}" opacity="0" x="${end}" y="${y - 13.5}" width="${cell}" height="17" fill="${terminalInk.prompt}"/></g>`);
    } else if (row.text) {
      lines.push(`<text${shown} y="${y}">${place(json(row.text))}</text>`);
    }
    if (row.cursor) lines.push(`<g${shown}><rect class="blink" x="${column(lead)}" y="${y - 13.5}" width="${cell}" height="17" fill="${terminalInk.prompt}"/></g>`);
    y += pitch;
  });
  const height = Math.round(y + 6);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="A terminal session: detect names the carrier of a tracking number, then track prints the parcel's scans with their stages">
  <style>
    text { font: 13px ${mono}; fill: ${terminalInk.text}; }
    .title { font: 12px ${sans}; fill: ${terminalInk.title}; }
    .command { fill: ${terminalInk.command}; } .prompt { fill: ${terminalInk.prompt}; } .key { fill: ${terminalInk.key}; } .string { fill: ${terminalInk.string}; }
    .blink { animation: blink 1.1s steps(1) infinite; } @keyframes blink { 50% { opacity: 0; } }
    .session { animation: session ${loop}s infinite; } @keyframes session { 0%, 96% { opacity: 1; } 99%, 100% { opacity: 0; } }
    ${motion.join('\n    ')}
    @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  </style>
  <clipPath id="window"><rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="11"/></clipPath>
  <rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" rx="12" fill="${terminalInk.window}" stroke="${terminalInk.edge}"/>
  <g clip-path="url(#window)">
    <rect width="${width}" height="${bar}" fill="${terminalInk.bar}"/>
    <path d="M0 ${bar}.5H${width}" stroke="${terminalInk.edge}"/>
    <circle cx="24" cy="20" r="6" fill="#ff5f57"/><circle cx="44" cy="20" r="6" fill="#febc2e"/><circle cx="64" cy="20" r="6" fill="#28c840"/>
    <text class="title" x="${width / 2}" y="24.5" text-anchor="middle">parcel-scraper — zsh</text>
    <g class="session">
      ${lines.join('\n      ')}
    </g>
  </g>
</svg>
`;
}
