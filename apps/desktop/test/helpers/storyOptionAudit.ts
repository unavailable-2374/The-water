/** TEST / SIMULATED semantic assessments. Evidence validation is real; literary judgments are fixtures. */
import type { StoryOption } from '@the-water/shared';
export const testQualityAudit = (card: StoryOption) => (['scopeCoverage', 'promisePayoff', 'characterProcess', 'resolutionSetup', 'lastingConsequences'] as const).map(checkpoint => ({ checkpoint, status: 'supported' as const, explanation: 'TEST SIMULATED supported assessment', evidence: [{ field: 'turns' as const, quote: card.turns[0]! }], findingIndices: [] as number[] }));
