// 配置页文案取舍（安静界面）：哪些说明删掉、哪些收进 InfoTip、哪些必须常驻可见。
// 静态标记只能验证结构与关联，不能验证悬停/聚焦行为。

import { describe, expect, test } from 'bun:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { DEFAULT_VISUAL_VALUES } from '@/types/visualConfig';
import { SectionAdvanced } from '@/features/config/components/sections/SectionAdvanced';
import { SectionCommon } from '@/features/config/components/sections/SectionCommon';
import { SectionConnectivity } from '@/features/config/components/sections/SectionConnectivity';
import { SectionLogging } from '@/features/config/components/sections/SectionLogging';
import { SectionNetwork } from '@/features/config/components/sections/SectionNetwork';
import { SectionPayload } from '@/features/config/components/sections/SectionPayload';
import { SectionStreaming } from '@/features/config/components/sections/SectionStreaming';

const translations = i18n.cloneInstance({ lng: 'en' });
const render = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n: translations }, element));
const escapeText = (value: string) =>
  renderToStaticMarkup(createElement('span', null, value)).slice(6, -7);
const t = (key: string) => escapeText(translations.t(`config_management.visual.${key}`));
const props = {
  values: DEFAULT_VISUAL_VALUES,
  disabled: false,
  onChange: () => {},
};
const renderSection = (Section: ComponentType<Record<string, unknown>>) =>
  render(createElement(Section, props));
/** Markup of one setting row, from its anchor to the next anchor. */
const rowOf = (markup: string, fieldId: string) =>
  markup.split(`id="cfg-field-${fieldId}"`)[1].split('id="cfg-field-')[0];
/** The section/group header that contains `title`. */
const headerWith = (markup: string, title: string) =>
  (markup.match(/<header\b.*?<\/header>/g) ?? []).find((header) => header.includes(title)) ?? '';

describe('section headers', () => {
  const sections = {
    common: SectionCommon,
    connectivity: SectionConnectivity,
    network: SectionNetwork,
    logging: SectionLogging,
    streaming: SectionStreaming,
    advanced: SectionAdvanced,
    payload: SectionPayload,
  } as Record<string, ComponentType<Record<string, unknown>>>;

  for (const [id, Section] of Object.entries(sections)) {
    test(`${id}: the title stands alone, without a subtitle or InfoTip`, () => {
      const markup = renderSection(Section);
      const header = markup.match(/<header\b.*?<\/header>/)?.[0] ?? '';
      expect(header).toContain(t(`sections.${id}.title`));
      expect(header).not.toMatch(/<p\b/);
      expect(header).not.toContain('data-info-tip');
      expect(markup).not.toContain(t(`sections.${id}.description`));
    });
  }
});

describe('advanced section copy', () => {
  const markup = renderSection(SectionAdvanced);

  test('Devin warning about deleting whole prompt lines stays visible', () => {
    const row = rowOf(markup, 'devinSensitiveWords');
    expect(row).toContain(t('sections.system.devin_sensitive_words_hint'));
    expect(row).not.toContain('data-info-tip');
    expect(row).not.toContain('visually-hidden');
    // The group's scope explanation moved into the group title's InfoTip.
    const header = headerWith(markup, t('sections.system.devin_sensitive_words'));
    expect(header).toContain('data-info-tip');
    expect(header).toContain(t('sections.system.devin_sensitive_words_desc'));
  });

  test('antigravity sensitive words: one InfoTip carries both what and how', () => {
    const header = headerWith(markup, t('sections.system.antigravity_sensitive_words'));
    expect(header).not.toContain('data-info-tip');
    const row = rowOf(markup, 'antigravitySensitiveWords');
    expect(row.match(/data-info-tip/g)).toHaveLength(1);
    expect(row).toContain(t('sections.system.antigravity_sensitive_words_desc'));
    expect(row).toContain(t('sections.system.antigravity_sensitive_words_hint'));
  });

  test('restating copy is gone: header defaults summary', () => {
    expect(markup).not.toContain(t('sections.headers.description'));
  });
});

describe('payload rule groups', () => {
  test('collapsible summaries carry only their titles', () => {
    const markup = renderSection(SectionPayload as ComponentType<Record<string, unknown>>);
    const summaries = markup.match(/<summary\b.*?<\/summary>/g) ?? [];
    expect(summaries).toHaveLength(6);
    for (const key of [
      'default_rules',
      'default_raw_rules',
      'override_rules',
      'override_raw_rules',
      'filter_rules',
    ]) {
      expect(markup).toContain(t(`sections.payload.${key}`));
    }
  });
});

describe('api keys block', () => {
  test('the header is just the title and the add action', () => {
    const markup = renderSection(SectionCommon);
    const cell = rowOf(markup, 'apiKeys');
    expect(cell).toContain(t('api_keys.label'));
    expect(cell).not.toContain(t('api_keys.hint'));
  });
});
