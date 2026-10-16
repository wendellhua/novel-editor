import { describe, expect, it } from 'vitest';
import { mergeEntities } from '../../src/server/bible/candidates';
import { NameIndex, cleanNames, nameKey } from '../../src/server/bible/names';

const entity = (name: string, aliases: string[] = [], facts: { attribute: string; value: string }[] = []) => ({
  name,
  kind: 'character' as const,
  aliases,
  summary: '',
  facts: facts.map((f) => ({ ...f, mutable: false, quote: '' })),
});

describe('INV-9 名称比较键与清洗', () => {
  it('nameKey：去空白、全半角统一、标点统一、大小写不敏感', () => {
    expect(nameKey(' 林 远 ')).toBe(nameKey('林远'));
    expect(nameKey('ＡＢ剑')).toBe(nameKey('ab剑'));
    expect(nameKey('「青云」')).toBe(nameKey('“青云”'));
    expect(nameKey('林远')).not.toBe(nameKey('林园'));
  });

  it('cleanNames：别名去重、去掉与名称相同的、去空值、截断长度与个数', () => {
    expect(cleanNames(' 林远 ', ['小林', ' 小 林', '林远', '', '远哥'])).toEqual({ name: '林远', aliases: ['小林', '远哥'] });
    expect([...cleanNames('名'.repeat(150), []).name]).toHaveLength(100);
    expect(cleanNames('甲', Array.from({ length: 80 }, (_, i) => `别名${i}`)).aliases).toHaveLength(50);
  });

  it('NameIndex：按比较键查找；conflict 忽略自身', () => {
    const index = new NameIndex([{ id: 'e1', name: '林远', aliases: '["小林"]' }, { id: 'e2', name: '青云门', aliases: 'oops' }]);
    expect([index.find('小 林'), index.find('青云门'), index.find('苏晴')]).toEqual(['e1', 'e2', null]);
    expect(index.conflict(['苏晴', '小林'])).toEqual({ name: '小林', entryId: 'e1', entryName: '林远' });
    expect(index.conflict(['林远', '小林'], 'e1')).toBeNull();
    index.remove('e1');
    expect(index.find('林远')).toBeNull();
  });
});

describe('同一份抽取输出中的实体合并', () => {
  it('声明对方为别名的一方成为主名称；别名与事实取并集；无关实体不受影响', () => {
    const out = mergeEntities([entity('小林', [], [{ attribute: '境界', value: '筑基' }]), entity('苏晴'), entity('林远', ['小林'], [{ attribute: '出身', value: '渔村' }])]);
    expect(out.map((e) => [e.name, e.aliases, e.facts.map((f) => f.attribute)])).toEqual([
      ['林远', ['小林'], ['境界', '出身']],
      ['苏晴', [], []],
    ]);
    // 后出现的以先出现者的名称为别名时，并入先出现者
    expect(mergeEntities([entity('林远'), entity('小林', ['林远'])]).map((e) => [e.name, e.aliases])).toEqual([['小林', ['林远']]]);
    expect(mergeEntities([entity('林远'), entity('林远', ['远哥'])]).map((e) => [e.name, e.aliases])).toEqual([['林远', ['远哥']]]);
  });
});
