import { z } from 'zod';
import { anchorEvidence } from '@the-water/shared';

/** Models supply quotations; the application computes authoritative UTF-16 offsets. */
export const ModelEvidenceSchema = z.object({
  quote: z.string().min(1).max(4000),
  // Optional hints retain compatibility and can disambiguate repeated quotes only after exact verification.
  from: z.number().int().optional(),
  to: z.number().int().optional(),
});
export function locateModelEvidence(source: string, evidence: z.infer<typeof ModelEvidenceSchema>) {
  return anchorEvidence(source, {
    from: evidence.from ?? -1,
    to: evidence.to ?? -1,
    quote: evidence.quote,
  });
}
