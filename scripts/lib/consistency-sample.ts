/**
 * 一致性检查基线样书（T17 验证）：8 章，设定库由前几章的原文预先建好（SEED）。
 * - CONTRADICTIONS：6 处埋好的矛盾（应当检出）；
 * - REASONABLE：3 处有交代的合理变化（不应报告为矛盾）。
 * 每处由 context（在全书中只出现一次的上下文）与 target（context 中的关键文字）描述，所在章节由 context 自动确定。
 */
import type { SampleChapter } from './bible-sample.ts';

export const CONSISTENCY_SAMPLE: readonly SampleChapter[] = [
  {
    title: '山门',
    body: '落霞镇渔家少年林远，生着一双乌黑的眼睛。他从落霞镇出发，翻山越岭走了整整三日，才到青云山下。\n测灵石亮起微光，守门的弟子瞥了他一眼：“炼气三层，资质平平。”林远攥紧了包袱。',
  },
  {
    title: '师姐',
    body: '内门弟子苏晴是长老玄机子的亲传弟子，也是林远的师姐。她生性清冷寡言，很少与人说笑。\n苏晴告诉林远，青云门有一条铁律：外门弟子不得擅入藏经阁。\n后山寒潭里沉着一柄玄冰剑，剑身晶莹如冰，百年来无人能拔出。',
  },
  {
    title: '外门',
    body: '外门师兄赵铁腰间挂着一把从不离身的长刀。他看不惯林远，处处刁难，对他十分敌视。\n林远每日劈柴挑水，夜里就在柴房里打坐。',
  },
  {
    title: '突破',
    body: '林远日夜修习《青云诀》，手上磨出了厚茧。三个月后的一个清晨，他体内灵气轰然贯通，终于突破到炼气九层。\n苏晴路过柴房，只点了点头，什么也没说。',
  },
  {
    title: '归乡',
    body: '母亲病重的消息传来，林远只用了半日便从青云山赶回落霞镇。\n镇上的老人看着他那双湛蓝的眼睛，都说这孩子上山以后变了。林远守在母亲床前，三天没有合眼。',
  },
  {
    title: '寒潭',
    body: '回山以后，苏晴带林远去了后山寒潭。林远伸手一握，玄冰剑应声而起，从此归他所有。\n当晚，林远大摇大摆地走进藏经阁，翻了一夜典籍，没有人阻拦。',
  },
  {
    title: '大比',
    body: '外门大比，赵铁挥舞着一柄长剑扑来。林远以玄冰剑连接三招，赵铁的兵器被寒气冻住，只得认输。\n比试过后，赵铁向林远抱拳：“是我小看了你。”两人从此冰释前嫌。',
  },
  {
    title: '夜谈',
    body: '以林远炼气五层的修为，本不该接住那一剑。消息传到内门，苏晴皱了皱眉。\n她只淡淡说了一句：“林师兄，下次别逞强。”说完便转身走了。',
  },
];

export interface Marker {
  id: string;
  context: string;
  target: string;
  note: string;
}

export const CONTRADICTIONS: readonly Marker[] = [
  { id: 'C1', context: '只用了半日便从青云山赶回', target: '半日', note: '路程：落霞镇到青云山要走三日（设定）' },
  { id: 'C2', context: '那双湛蓝的眼睛', target: '湛蓝', note: '外貌：林远的眼睛是乌黑的（角色）' },
  { id: 'C3', context: '大摇大摆地走进藏经阁', target: '走进藏经阁', note: '规矩：外门弟子不得擅入藏经阁（设定）' },
  { id: 'C4', context: '赵铁挥舞着一柄长剑', target: '长剑', note: '物品：赵铁的兵器是从不离身的长刀（设定 / 角色）' },
  { id: 'C5', context: '以林远炼气五层的修为', target: '炼气五层', note: '境界：上一章已是炼气九层，没有交代的倒退（设定）' },
  { id: 'C6', context: '“林师兄，下次别逞强。”', target: '林师兄', note: '称谓：苏晴是林远的师姐，不该叫他师兄（角色）' },
];

export const REASONABLE: readonly Marker[] = [
  { id: 'R1', context: '终于突破到炼气九层', target: '炼气九层', note: '境界：有修炼与突破的交代' },
  { id: 'R2', context: '玄冰剑应声而起，从此归他所有', target: '从此归他所有', note: '物品归属：有拔剑的交代' },
  { id: 'R3', context: '两人从此冰释前嫌', target: '冰释前嫌', note: '关系：有比试与道歉的交代' },
];

/** 预先建好的设定库：事实的引文取自前几章原文（chapter 为章序，从 0 起）。 */
export interface SeedEntry {
  kind: 'character' | 'location' | 'faction' | 'item';
  name: string;
  aliases: string[];
  summary: string;
  facts: { attribute: string; value: string; mutable: boolean; chapter: number; quote: string }[];
}

export const SEED: readonly SeedEntry[] = [
  {
    kind: 'character',
    name: '林远',
    aliases: [],
    summary: '落霞镇渔家少年，青云门外门弟子',
    facts: [
      { attribute: '出身', value: '落霞镇渔家', mutable: false, chapter: 0, quote: '落霞镇渔家少年林远' },
      { attribute: '瞳色', value: '乌黑', mutable: false, chapter: 0, quote: '生着一双乌黑的眼睛' },
      { attribute: '境界', value: '炼气三层', mutable: true, chapter: 0, quote: '炼气三层，资质平平。' },
      { attribute: '境界', value: '炼气九层', mutable: true, chapter: 3, quote: '终于突破到炼气九层' },
    ],
  },
  {
    kind: 'character',
    name: '苏晴',
    aliases: [],
    summary: '玄机子的亲传弟子，林远的师姐',
    facts: [
      { attribute: '身份', value: '林远的师姐', mutable: false, chapter: 1, quote: '也是林远的师姐' },
      { attribute: '性格', value: '清冷寡言', mutable: false, chapter: 1, quote: '她生性清冷寡言，很少与人说笑。' },
    ],
  },
  {
    kind: 'character',
    name: '赵铁',
    aliases: [],
    summary: '青云门外门师兄',
    facts: [
      { attribute: '兵器', value: '从不离身的长刀', mutable: false, chapter: 2, quote: '腰间挂着一把从不离身的长刀' },
      { attribute: '与林远的关系', value: '敌视', mutable: true, chapter: 2, quote: '对他十分敌视' },
    ],
  },
  {
    kind: 'location',
    name: '落霞镇',
    aliases: [],
    summary: '林远的家乡',
    facts: [{ attribute: '到青云山的路程', value: '步行三日', mutable: false, chapter: 0, quote: '翻山越岭走了整整三日，才到青云山下' }],
  },
  {
    kind: 'faction',
    name: '青云门',
    aliases: [],
    summary: '林远拜入的门派',
    facts: [{ attribute: '门规', value: '外门弟子不得擅入藏经阁', mutable: false, chapter: 1, quote: '外门弟子不得擅入藏经阁' }],
  },
  {
    kind: 'item',
    name: '玄冰剑',
    aliases: [],
    summary: '后山寒潭中的古剑',
    facts: [
      { attribute: '外观', value: '剑身晶莹如冰', mutable: false, chapter: 1, quote: '剑身晶莹如冰' },
      { attribute: '归属', value: '沉在寒潭，无人能拔出', mutable: true, chapter: 1, quote: '百年来无人能拔出' },
    ],
  },
];

/** 标记在样书中的位置（章序与章内 UTF-16 范围）；context 必须在全书中只出现一次。 */
export function locateMarker(m: Marker, book: readonly SampleChapter[] = CONSISTENCY_SAMPLE): { chapter: number; start: number; end: number } {
  const hits = book.flatMap((c, i) => (c.body.includes(m.context) ? [i] : []));
  if (hits.length !== 1) throw new Error(`上下文必须在样书中恰好出现一次：${m.context}`);
  const chapter = hits[0] as number;
  const body = (book[chapter] as SampleChapter).body;
  const at = body.indexOf(m.context);
  if (body.indexOf(m.context, at + 1) >= 0) throw new Error(`上下文在章内重复：${m.context}`);
  const offset = m.context.indexOf(m.target);
  if (offset < 0) throw new Error(`上下文中没有关键文字：${m.context} / ${m.target}`);
  return { chapter, start: at + offset, end: at + offset + m.target.length };
}
