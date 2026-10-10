import { listCurrentVersions } from '@/db/repos/chaptersRepo';

/** Keep queue admission and worker eligibility identical. Short prose remains valid writing. */
export async function listStyleExtractionSources(novelId: string) {
  return (await listCurrentVersions(novelId)).filter(
    row => row.version && row.version.content.trim().length > 200,
  );
}
