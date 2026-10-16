/** 确定性伪随机数（mulberry32），保证属性测试可复现。 */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = [
  ...'天地玄黄宇宙洪荒日月盈昃辰宿列张林惊羽青云山噬魂棒',
  ...'。！？…”“，、；：‘’「」《》—',
  ...'abcXYZ019 ',
  'ＡＢ１',
  '\u3000',
  '\n',
  '\n',
  '\t',
  '😀',
  '👍',
];

export function randomText(rand: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(rand() * ALPHABET.length)] ?? '字';
  }
  return out;
}
