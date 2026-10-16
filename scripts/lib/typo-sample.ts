/**
 * 错别字检查基线样章（T14 验证）：一章约 800 字的正文，埋了 20 处已知错误。
 * 每处错误由 context（在样章中只出现一次的上下文）、wrong（context 中的错误文字）、right（正确写法）描述。
 */
export interface KnownError {
  kind: 'typo' | 'punctuation' | 'grammar';
  context: string;
  wrong: string;
  right: string;
}

export const TYPO_SAMPLE = `清晨的雾气还没有散去，林远已经站在了演武场中央。昨夜师父的话还在耳边：“修行之路，最忌心浮气燥。”他深吸一口气，提醒自己要按步就班，不可急于求成。

师兄赵铁走过来，拍了拍他的肩膀：“上次比试你输得不冤，这次要在接再厉。”林远默默的点头，没有多说什么。

演武场边上围满了人，大家迫不急待地想看今天的比试。有人谈笑风声，有人低声议论，说赵铁私下挖墙角，把别的峰的弟子拉了过来。林远听在耳里，只当没有听见。

比试开始，林远的身形象一阵风，绕到对手身后。对手竞然没有察觉，被他一掌推出了圈外。台下一片哗然，裁判愣了片刻，才宣布林远获胜。

“你怎么做到的?”师妹苏晴跑的飞快，挤到他面前问道。林远笑了笑：“一但想通了，其实也不难。”

傍晚，他回到住处，翻开那本旧帐本。这是母亲留下的，上面记着这些年家里的每一笔开销。山中气侯多变，母亲为了供他上山，渡过了最艰难的日子。

他他合上本子，望着窗外的晚霞，低声说,我以经不是当年那个孩子了。哪怕前路再难，他也再所不惜。窗外的风停了。。。远处传来钟声。
`;

export const KNOWN_ERRORS: readonly KnownError[] = [
  { kind: 'typo', context: '心浮气燥', wrong: '燥', right: '躁' },
  { kind: 'typo', context: '按步就班', wrong: '步', right: '部' },
  { kind: 'typo', context: '要在接再厉', wrong: '在', right: '再' },
  { kind: 'typo', context: '默默的点头', wrong: '的', right: '地' },
  { kind: 'typo', context: '迫不急待', wrong: '急', right: '及' },
  { kind: 'typo', context: '谈笑风声', wrong: '声', right: '生' },
  { kind: 'typo', context: '挖墙角', wrong: '角', right: '脚' },
  { kind: 'typo', context: '身形象一阵风', wrong: '象', right: '像' },
  { kind: 'typo', context: '竞然', wrong: '竞', right: '竟' },
  { kind: 'punctuation', context: '做到的?', wrong: '?', right: '？' },
  { kind: 'typo', context: '跑的飞快', wrong: '的', right: '得' },
  { kind: 'typo', context: '一但', wrong: '但', right: '旦' },
  { kind: 'typo', context: '旧帐本', wrong: '帐', right: '账' },
  { kind: 'typo', context: '气侯', wrong: '侯', right: '候' },
  { kind: 'typo', context: '渡过了', wrong: '渡', right: '度' },
  { kind: 'grammar', context: '他他合上', wrong: '他他', right: '他' },
  { kind: 'punctuation', context: '低声说,', wrong: ',', right: '，' },
  { kind: 'typo', context: '我以经', wrong: '以', right: '已' },
  { kind: 'typo', context: '再所不惜', wrong: '再', right: '在' },
  { kind: 'punctuation', context: '停了。。。', wrong: '。。。', right: '……' },
];

/** 每处已知错误在样章中的范围（UTF-16）。context 不唯一时抛错，保证样章本身合法。 */
export function knownErrorRanges(sample: string = TYPO_SAMPLE, errors: readonly KnownError[] = KNOWN_ERRORS): { error: KnownError; start: number; end: number }[] {
  return errors.map((error) => {
    const at = sample.indexOf(error.context);
    if (at < 0 || sample.indexOf(error.context, at + 1) >= 0) throw new Error(`样章中的上下文必须恰好出现一次：${error.context}`);
    const offset = error.context.indexOf(error.wrong);
    if (offset < 0) throw new Error(`上下文中没有错误文字：${error.context} / ${error.wrong}`);
    return { error, start: at + offset, end: at + offset + error.wrong.length };
  });
}

/** 全部改正后的正文。 */
export function correctedSample(sample: string = TYPO_SAMPLE, errors: readonly KnownError[] = KNOWN_ERRORS): string {
  let out = sample;
  for (const e of errors) out = out.replace(e.context, e.context.replace(e.wrong, e.right));
  return out;
}
