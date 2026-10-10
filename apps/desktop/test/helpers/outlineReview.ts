/** THIS IS SIMULATED: report fixture for flow tests, not an assessment of literary quality. */
import { OUTLINE_REVIEW_DIMENSIONS, type OutlineReview } from '@the-water/shared';
export function simulatedOutlineReview(): OutlineReview {
  return { premise: { documentKind: 'TEST SIMULATED total outline', stage: 'TEST draft', primaryExperience: 'TEST', audience: 'TEST', lengthAndReadingForm: 'TEST', uncertainties: [] }, summary: 'TEST SIMULATED editorial review', checks: OUTLINE_REVIEW_DIMENSIONS.map(dimension => ({ dimension, status: 'needs_information' as const, assessment: 'TEST SIMULATED unknown, never claim quality passed', evidence: [] })), causalChains: [{location:'TEST SIMULATED',priorConditions:'TEST unknown',action:'TEST unknown',change:'TEST unknown',consequence:'TEST unknown'}], timeline: [{event:'TEST SIMULATED',happensAt:'TEST unknown',characterLearnsAt:'TEST unknown',readerLearnsAt:'TEST unknown',materialOriginAndTransfer:'TEST unknown'}], findings: [], proseValidation: ['TEST SIMULATED prose still needs testing'] };
}
/** Attach an explicitly simulated review for tests focused on conversion/adoption, not model review. */
export async function attachSimulatedOutlineReview(novelId: string, id: string) {
  const { listDocumentPlans } = await import('@/db/repos/planProposalsRepo');
  const { outlineReviewInput } = await import('@/novel/outlineReview');
  const { outlineReviewSignature } = await import('@the-water/shared');
  const { getDb } = await import('@/db/db');
  const p = (await listDocumentPlans(novelId)).find(p => p.id === id)!;
  p.meta.outlineReview = { state: 'complete', signature: await outlineReviewSignature(await outlineReviewInput(novelId,p)), error: null, report: simulatedOutlineReview(), reviewedAt: 0 };
  await getDb().execute('UPDATE writing_proposals SET json=? WHERE id=?', [JSON.stringify(p),id]);
}
