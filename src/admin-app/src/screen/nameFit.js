// 揭晓名字卡的字号计算（纯函数，可被 Node 测试直接导入）。
// 单行放得下就单行；最小字号仍放不下的超长名字（如长英文全名），改为在卡片内折成两到三行，
// 绝不返回一个已知放不下的字号让名字溢出卡片、压到相邻的中奖人。

export const MIN_SCREEN_FONT_SIZE = 28;
export const LONG_NAME_MIN_FONT_PX = 14;
// 折行时的最小字号：再小大屏上就读不清了；配合行数截断与溢出隐藏，任何情况下都不会越出卡片。
export const WRAP_MIN_FONT_PX = 12;
export const NAME_LINE_HEIGHT = 1.18;
const WRAP_MAX_LINES = 3;
// 折行按字宽估算，断行位置不一定刚好落在行尾，留一点余量。
const WRAP_WIDTH_SLACK = 0.9;

export function countNameChars(text) {
  return Array.from(String(text || '').trim()).length;
}

function getLengthScaleFactor(charCount) {
  if (charCount <= 3) return 1;
  if (charCount === 4) return 0.85;
  if (charCount === 5) return 0.75;
  return 0.65;
}

export function estimateVisualUnits(text) {
  const str = String(text || '').trim();
  let units = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) || 0;
    if (code <= 0x7f) {
      units += code >= 0x41 && code <= 0x5a ? 0.8 : 0.64;
    } else {
      units += 1.06;
    }
  }
  return Math.max(1, units);
}

// 与 screen.css 中 .gs-reveal-card（2px 边框）和各档 .gs-reveal-card-inner 的内边距一致。
function cardPadding(tier) {
  if (tier === 'hero') return { x: 100, y: 52 };
  if (tier === 'dense' || tier === 'compact') return { x: 24, y: 12 };
  return { x: 32, y: 24 };
}

// 原有的单行字号规则（6–8 列默认不低于 28px，≥5 个字放不下时按比例缩小，不使用省略号）。
function singleLineFontSize(chars, fitWidth, layout) {
  if (layout.cols >= 6) {
    const baseSize = Math.max(MIN_SCREEN_FONT_SIZE, layout.fontSize);
    if (chars < 5) return Math.max(MIN_SCREEN_FONT_SIZE, Math.min(baseSize, fitWidth));
    if (fitWidth >= MIN_SCREEN_FONT_SIZE) return Math.min(baseSize, fitWidth);
    return Math.max(LONG_NAME_MIN_FONT_PX, fitWidth);
  }
  const tierScaled = Math.round(layout.fontSize * getLengthScaleFactor(chars));
  if (chars < 5) return Math.max(MIN_SCREEN_FONT_SIZE, Math.min(tierScaled, fitWidth));
  return Math.max(LONG_NAME_MIN_FONT_PX, Math.min(tierScaled, fitWidth));
}

/**
 * 返回 { fontSize, lines }：lines 为 1 表示单行（不折行）；大于 1 表示折成至多 lines 行。
 */
export function computeCardNameFit(name, layout) {
  const text = String(name || '').trim();
  const chars = countNameChars(text);
  const units = estimateVisualUnits(text);
  const pad = cardPadding(layout.tier);
  const availWidth = Math.max(80, layout.cardW - pad.x);
  const availHeight = Math.max(20, layout.cardH - pad.y);
  const fitWidth = Math.floor(availWidth / units);

  const single = singleLineFontSize(chars, fitWidth, layout);
  if (single <= fitWidth) return { fontSize: single, lines: 1 };

  // 单行在最小字号下也放不下：在卡片宽高内找能放下的最大折行字号，不超过这一档名字卡本来的字号。
  const cap = layout.cols >= 6
    ? Math.max(MIN_SCREEN_FONT_SIZE, layout.fontSize)
    : Math.round(layout.fontSize * getLengthScaleFactor(chars));
  let best = { fontSize: 0, lines: 2 };
  for (let lines = 2; lines <= WRAP_MAX_LINES; lines += 1) {
    const byWidth = Math.floor((availWidth * lines * WRAP_WIDTH_SLACK) / units);
    const byHeight = Math.floor(availHeight / (lines * NAME_LINE_HEIGHT));
    const size = Math.min(cap, byWidth, byHeight);
    if (size > best.fontSize) best = { fontSize: size, lines };
  }
  return { fontSize: Math.max(WRAP_MIN_FONT_PX, best.fontSize), lines: best.lines };
}
