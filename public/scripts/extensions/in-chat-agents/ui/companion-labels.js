import { t } from '../../../i18n.js';

export function companionLabels() {
    return {
        trigger: [['auto', t`Auto`], ['manual', t`Manual`]],
        displayMode: [
            ['card', t`Note card`],
            ['panel', t`Tracker panel only`],
            ['hidden', t`Hidden feedback note`],
        ],
        format: [['markdown', t`Markdown`], ['html', t`HTML`], ['text', t`Text`]],
        batch: t`Batch`,
        feedback: t`Feed Recent Notes`,
    };
}

export function companionSummary(config, enabled) {
    const labels = companionLabels();
    const optionLabel = key => labels[key].find(([value]) => value === config[key])?.[1] ?? config[key];
    const feedback = labels.feedback;
    const depth = config.feedback?.depth;
    return [
        enabled ? t`On` : t`Off`,
        ...['trigger', 'displayMode', 'format'].map(optionLabel),
        config.batch ? labels.batch : '',
        config.feedback?.enabled ? t`${feedback} ×${depth}` : '',
    ].filter(Boolean).join(' · ');
}
