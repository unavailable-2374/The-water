import { z } from 'zod';
import { nanoid } from 'nanoid';
import { canonicalJson, sha256Hex, anchorEvidence } from '@the-water/shared';
import { getDb, now } from '@/db/db';
import { revisionSource } from './structuralRevision';
import { getVersion } from '@/db/repos/chaptersRepo';

export type LiteraryReviewTask = 'first_reading' | 'consistency' | 'revision_value';
export interface BlindPacket { id:string; task:LiteraryReviewTask; instruction:string; texts:Array<{label:string;chapterNo:number;text:string}>; materials?:unknown }
export const HumanLiteraryReviewSchema = z.object({
  judgment:z.string().trim().min(1).max(6000),
  findings:z.array(z.object({ label:z.string().min(1),chapterNo:z.number().int().positive(),quote:z.string().min(1).max(4000),effect:z.enum(['improved','lost','confusing','preserve']),reason:z.string().trim().min(1).max(4000) })).max(50),
});
const instructions:Record<LiteraryReviewTask,string> = {
  first_reading:'仅阅读截至当前章的正文，不读作者资料。记录目标、为何重要、做法与替代、继续读的期待、想跳读处；区分吸引继续读的疑问与妨碍当前理解的困惑。引用具体原文，不要求全部心理立即解释。',
  consistency:'核对正文与已确认资料的实际知识、时空、规则和动机冲突。计划不等于已发生事实；人物相信、说谎与作品确认的事实分开。有意留白、情绪或习惯尚未改变、平静互动和开放结尾不自动算缺陷。',
  revision_value:'X 与 Y 的身份和先后已隐藏。比较具体改善及损失，关注人物理解、投入、声音、必要歧义、余味、对白决定权、重复动作意义及平静互动。不把解释更多视为必然更好，允许无胜者。逐项引用正文；不猜版本身份。',
};
export async function prepareLiteraryReview(novelId:string,chapterId:string,task:LiteraryReviewTask,otherVersionId?:string) {
  const source=await revisionSource(novelId), chapter=source.w.chapters.find(c=>c.id===chapterId), current=source.prose.find(p=>p.chapterId===chapterId)?.version;
  if(!chapter || !current) throw new Error('请先保存待评阅正文');
  const id=nanoid(),texts:BlindPacket['texts']=[],mapping:Array<{label:string;chapterNo:number;versionId:string;contentHash:string}>=[];
  const add=async(label:string,chapterNo:number,v:NonNullable<typeof current>)=>{texts.push({label,chapterNo,text:v.content});mapping.push({label,chapterNo,versionId:v.id,contentHash:await sha256Hex(v.content)});};
  if(task==='revision_value') {
    const other=otherVersionId ? await getVersion(otherVersionId):null;
    if(!other || other.chapterId!==chapterId || other.id===current.id) throw new Error('请为比较选择同章的另一个真实版本');
    const order=crypto.getRandomValues(new Uint8Array(1))[0]!%2===0 ? [current,other] : [other,current];
    await add('X',chapter.chapterNo,order[0]!);await add('Y',chapter.chapterNo,order[1]!);
  } else {
    for(const c of source.w.chapters.filter(c=>c.chapterNo<chapter.chapterNo)) {
      const v=c.committedVersionId ? await getVersion(c.committedVersionId):null;
      if(!v) throw new Error(`缺少第 ${c.chapterNo} 章已提交正文，不能生成完整首次阅读材料`);
      await add('正文',c.chapterNo,v);
    }
    await add('正文',chapter.chapterNo,current);
  }
  const packet:BlindPacket={id,task,instruction:instructions[task],texts,...(task==='consistency'?{materials:{doc:source.doc,cards:source.w.cards.filter(c=>c.confirmed),graph:source.w.graph}}:{})};
  const privateRecord={packet,mapping,signature:source.signature,packetHash:await sha256Hex(canonicalJson(packet)),state:'awaiting_human',feedback:null};
  await getDb().atomic([...source.guards,{sql:"INSERT INTO story_suggestions(id,novel_id,kind,json,created_at) VALUES (?,?,'literary_evaluation',?,?)",params:[id,novelId,JSON.stringify(privateRecord),now()]}]);
  return packet;
}
/** A human response remains explicitly human, never auto-filled from an AI review. */
export async function saveHumanLiteraryReview(novelId:string,id:string,feedback:z.infer<typeof HumanLiteraryReviewSchema>) {
  const [row]=await getDb().select<{json:string}>("SELECT json FROM story_suggestions WHERE id=? AND novel_id=? AND kind='literary_evaluation'",[id,novelId]);
  if(!row) throw new Error('评阅材料不存在');
  const record=JSON.parse(row.json),parsed=HumanLiteraryReviewSchema.parse(feedback);
  for(const finding of parsed.findings) {
    const source=(record.packet.texts as BlindPacket['texts']).find(s=>s.label===finding.label&&s.chapterNo===finding.chapterNo);
    if(!source) throw new Error('评阅引用了未提供的文本');
    anchorEvidence(source.text,{from:-1,to:-1,quote:finding.quote});
  }
  await getDb().atomic([{sql:"UPDATE story_suggestions SET json=? WHERE id=? AND novel_id=? AND json=?",params:[JSON.stringify({...record,state:'human_reviewed',feedback:parsed}),id,novelId,row.json],expectedRows:1}]);
}

export async function listLiteraryReviewPackets(novelId:string):Promise<Array<{packet:BlindPacket;state:string;feedback:z.infer<typeof HumanLiteraryReviewSchema>|null}>> {
  return (await getDb().select<{json:string}>("SELECT json FROM story_suggestions WHERE novel_id=? AND kind='literary_evaluation' ORDER BY created_at DESC",[novelId])).map(row=>{const r=JSON.parse(row.json);return {packet:r.packet,state:r.state,feedback:r.feedback};});
}
