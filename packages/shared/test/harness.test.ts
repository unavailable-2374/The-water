import { describe, expect, it } from 'vitest';
import { HarnessCapabilitiesSchema,TopicTreeScopeSchema } from '../src/harness';

// TEST protocol metadata; not a real service response or model result.
const caps = { enabled: true, protocolVersion: 1, provider: 'lunaroute', model: 'TEST-model',
  contextWindow: 1048576, maxOutputTokens: 262144, reasoningTokens: 32000,
  reasoningEffort: 'low', jsonMode: 'json_schema', retentionHours: 24 };
describe('TEST harness engine compatibility', () => {
  it('accepts current Pi and historical Mastra services', () => {
    for (const engine of ['pi', 'mastra'])
      expect(HarnessCapabilitiesSchema.parse({ ...caps, engine }).engine).toBe(engine);
  });
  it('rejects unknown engines instead of pretending compatibility', () => {
    expect(HarnessCapabilitiesSchema.safeParse({ ...caps, engine: 'TEST-unsupported' }).success).toBe(false);
  });
});

it('TEST topic memory follows actual chapter positions without imposing a novel length quota',()=>{
 const scope={workId:'TEST-work',branchId:'adopted',channel:'writing',epoch:'a'.repeat(64),chapterNo:501};
 expect(TopicTreeScopeSchema.parse(scope).chapterNo).toBe(501);
 expect(TopicTreeScopeSchema.safeParse({...scope,chapterNo:-1}).success).toBe(false);
});
