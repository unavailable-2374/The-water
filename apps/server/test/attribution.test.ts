/**
 * §3.7 许可与署名：许可全文链接、非商业提示、bundle 与作品页的机器可读署名块。
 */
import { describe, expect, it } from 'bun:test';
import {
  ATTRIBUTION_SPEC,
  AttributionResponseSchema,
  LICENSE_META,
  NovelBundleV1Schema,
  licenseUrl,
  nonCommercialNotice,
} from '@the-water/shared';
import { createNovel, makeChapters, makeTestApp, publish } from './helpers';

describe('§3.7 许可元数据', () => {
  it('每种许可都能拿到全文链接与义务标记', () => {
    expect(licenseUrl('cc-by-nc-sa')).toBe('https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode');
    expect(licenseUrl('all-rights-reserved')).toBeNull();
    expect(LICENSE_META['cc-by-nc'].nonCommercial).toBe(true);
    expect(LICENSE_META['cc-by-sa'].shareAlike).toBe(true);
    expect(LICENSE_META['cc-by'].nonCommercial).toBe(false);
    expect(LICENSE_META.cc0.requiresAttribution).toBe(false);
    // `-nc` 终于有了一句可以摆到界面上的提示（此前完全没有任何提示）。
    expect(nonCommercialNotice('cc-by-nc')).toContain('非商业');
    expect(nonCommercialNotice('cc-by')).toBeNull();
  });
});

describe('§3.7 署名块', () => {
  it('原创作品的署名块只有本作，带许可全文链接', async () => {
    const t = makeTestApp({ env: { publicBaseUrl: 'https://water.example' } });
    const { token } = await t.register('a@example.com');
    const n = await createNovel(t, token, { title: '灯下长街', license: 'cc-by-nc', allowDerivatives: true });
    await publish(t, token, n.id, await makeChapters(2, 1, 200));

    const r = await t.json('GET', `/api/v1/novels/${n.id}/attribution`);
    expect(r.status).toBe(200);
    const { attribution } = AttributionResponseSchema.parse(r.body);
    expect(attribution.spec).toBe(ATTRIBUTION_SPEC);
    expect(attribution.derivedFrom).toBeNull();
    expect(attribution.chain).toEqual([]);
    expect(attribution.work.title).toBe('灯下长街');
    expect(attribution.work.licenseUrl).toBe(licenseUrl('cc-by-nc'));
    expect(attribution.work.url).toBe(`https://water.example/n/${n.id}`);
    expect(attribution.work.versionNumber).toBe(1);
    expect(attribution.nonCommercial).toBe(true);
    expect(attribution.notice).toContain('灯下长街');
    expect(attribution.notice).toContain('非商业');
  });

  it('二创的署名块带上完整来源链条，并进入 bundle', async () => {
    const t = makeTestApp({ env: { publicBaseUrl: 'https://water.example' } });
    const { token: a } = await t.register('a@example.com', '原作者');
    const { token: b } = await t.register('b@example.com', '二创作者');
    const { token: c } = await t.register('c@example.com', '三创作者');

    const root = await createNovel(t, a, { title: '原作', license: 'cc-by-sa', allowDerivatives: true });
    await publish(t, a, root.id, await makeChapters(1, 1, 200));

    const fork1 = await t.json('POST', `/api/v1/novels/${root.id}/forks`, { token: b, body: {} });
    const mid = await createNovel(t, b, {
      title: '续写',
      license: 'cc-by-sa',
      allowDerivatives: true,
      source: { forkId: fork1.body.fork.id },
    } as never);
    await publish(t, b, mid.id, await makeChapters(1, 2, 200));

    const fork2 = await t.json('POST', `/api/v1/novels/${mid.id}/forks`, { token: c, body: {} });
    const leaf = await createNovel(t, c, {
      title: '再续',
      license: 'cc-by-sa',
      allowDerivatives: true,
      source: { forkId: fork2.body.fork.id },
    } as never);
    await publish(t, c, leaf.id, await makeChapters(1, 3, 200));

    const { attribution } = AttributionResponseSchema.parse(
      (await t.json('GET', `/api/v1/novels/${leaf.id}/attribution`)).body,
    );
    // chain 是「根作品 → 直接来源」的顺序，derivedFrom 是直接来源。
    expect(attribution.chain.map((p) => p.title)).toEqual(['原作', '续写']);
    expect(attribution.derivedFrom?.title).toBe('续写');
    expect(attribution.chain[0]!.author.displayName).toBe('原作者');
    expect(attribution.chain[0]!.versionNumber).toBe(1);
    expect(attribution.shareAlike).toBe(true);
    expect(attribution.notice).toContain('改编自');
    expect(attribution.notice).toContain('原作');

    // bundle 自带同一份署名块，导出成文件后也不会丢。
    const bundle = NovelBundleV1Schema.parse(
      (await t.json('GET', `/api/v1/novels/${leaf.id}/versions/current/bundle`)).body,
    );
    expect(bundle.attribution?.chain.map((p) => p.title)).toEqual(['原作', '续写']);
    expect(bundle.attribution?.work.licenseUrl).toBe(licenseUrl('cc-by-sa'));
  });

  it('来源下架后仍保留署名信息，但不再给出可点的链接', async () => {
    const t = makeTestApp({ env: { publicBaseUrl: 'https://water.example' } });
    const { token: a } = await t.register('a@example.com', '原作者');
    const { token: b } = await t.register('b@example.com', '二创作者');
    const root = await createNovel(t, a, { title: '原作', license: 'cc-by', allowDerivatives: true });
    await publish(t, a, root.id, await makeChapters(1, 1, 200));
    const fork = await t.json('POST', `/api/v1/novels/${root.id}/forks`, { token: b, body: {} });
    const deriv = await createNovel(t, b, {
      title: '续写',
      license: 'cc-by',
      allowDerivatives: true,
      source: { forkId: fork.body.fork.id },
    } as never);
    await publish(t, b, deriv.id, await makeChapters(1, 2, 200));

    await t.json('PATCH', `/api/v1/novels/${root.id}`, { token: a, body: { visibility: 'unpublished' } });
    const { attribution } = AttributionResponseSchema.parse(
      (await t.json('GET', `/api/v1/novels/${deriv.id}/attribution`)).body,
    );
    // 署名是许可义务，不能因为原作下架就抹掉作者名。
    expect(attribution.derivedFrom?.title).toBe('原作');
    expect(attribution.derivedFrom?.author.displayName).toBe('原作者');
    expect(attribution.derivedFrom?.available).toBe(false);
    expect(attribution.derivedFrom?.url).toBeNull();
  });

  it('未发布 / 不可见的作品拿不到署名块', async () => {
    const t = makeTestApp();
    const { token: a } = await t.register('a@example.com');
    const { token: b } = await t.register('b@example.com');
    const n = await createNovel(t, a, { title: '还没发' });
    expect((await t.json('GET', `/api/v1/novels/${n.id}/attribution`)).status).toBe(404);
    expect((await t.json('GET', `/api/v1/novels/${n.id}/attribution`, { token: b })).status).toBe(404);
    // 作者自己看得到。
    expect((await t.json('GET', `/api/v1/novels/${n.id}/attribution`, { token: a })).status).toBe(200);
  });
});
