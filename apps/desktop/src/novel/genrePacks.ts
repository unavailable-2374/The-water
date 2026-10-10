/**
 * 题材包（L1）：介于通用层（L0：docs/writing/lexicon 的 AI 味词表 + docTypes 的文章类型框架）
 * 与作品层（L2：storyline / bible / StyleProfile）之间的一层，见 docs/writing/README.md §3.1。
 *
 * 一本书可以同时选多个包（科幻 + 悬疑），合并规则是确定性的：
 *   - 禁用词 / 禁用句式 / 桥段 / 大纲提示 / 写作规则 / 质检项：并集去重；多包补入共同场景与稳定边界指导
 *   - 数值靶区间：取交集；交集为空时后选的包胜出，并记入 `conflicts` 供 UI 提示
 *   - lore 条目：按 id 去重（先出现的胜出）；作品层同名条目覆盖题材层（见 context.mergeLoreSettings）
 *
 * 题材包只提供缺省，作品层永远优先；`requirements.disabledLore` 可以逐条关掉包里的条目。
 */
import type { Setting, SettingKind, StyleProfile, StyleTargets } from '@the-water/shared';
import type { NovelRequirements } from './types';

export type GenreTargetKey = 'sentenceMean' | 'burstiness' | 'paragraphMean' | 'dialogueRatio' | 'exclamationPerK' | 'ellipsisPerK';
export type GenreTargets = Partial<Record<GenreTargetKey, [number, number]>>;

/** 题材创作指导，复用 Setting 形状和稳定 ID 注入；不是本书已确认事实。 */
export interface GenreLoreEntry {
  /** 稳定 id：`${packId}:${slug}`；作品可用 requirements.disabledLore 关掉。 */
  id: string;
  name: string;
  kind: SettingKind;
  description: string;
  triggerKeys: string[];
  /** 缺省 40–70；低于作品层默认的 50 时，作品条目在预算里优先。 */
  priority: number;
  constant: boolean;
}

export interface GenrePack {
  id: string;
  label: string;
  /** 旧 requirements.genre 的取值，用于自动迁移与 UI 推荐。 */
  aliases: string[];
  summary: string;
  entries: GenreLoreEntry[];
  /** 硬禁用词（lint 记 block）。 */
  forbiddenWords: string[];
  /** 软限制词，沿用 L0 的每千字上限。 */
  softWords: string[];
  /** 禁用句式，`…` 为通配（与 StyleNegatives.avoidPatterns 同格式）。 */
  forbiddenPatterns: string[];
  tropes: { use: string[]; avoid: string[] };
  outlineHints: string[];
  writingRules: string[];
  qc: string[];
  targets: GenreTargets;
  /** 推荐的文风预设 id（stylePresets）。 */
  presetIds: string[];
}

export const GENRE_PACKS: GenrePack[] = [
  {
    "id": "xianxia",
    "label": "仙侠 / 玄幻",
    "aliases": [
      "玄幻",
      "仙侠",
      "奇幻"
    ],
    "summary": "先选择成长、探索、神话、权谋或奇异日常体验；力量规则服务选择和后果，不预设统一境界。",
    "entries": [
      {
        "id": "xianxia:realms",
        "name": "境界体系",
        "kind": "rule",
        "description": "仅在本书采用境界时规划其层级与边界；不默认炼气/筑基、不默认跨级碾压。核心解法依赖的能力须有前文依据，未知神秘力量可以保留未知。",
        "triggerKeys": [
          "境界",
          "修为",
          "突破",
          "能力"
        ],
        "priority": 70,
        "constant": true
      },
      {
        "id": "xianxia:qi",
        "name": "灵气与丹药",
        "kind": "rule",
        "description": "若作品有灵气、丹药或法宝，记录作用、使用条件、不能做什么及使用影响；其取得和资源分配如何影响生活，以本书设定为准。",
        "triggerKeys": [
          "灵气",
          "丹药",
          "灵石",
          "法宝",
          "灵脉"
        ],
        "priority": 50,
        "constant": false
      },
      {
        "id": "xianxia:sect",
        "name": "宗门与辈分",
        "kind": "rule",
        "description": "若存在宗门，设计资源、权力、礼俗、信任与修行目标的关系；不默认组织序列或称谓，修行与长生应影响时间感、人情和价值选择。",
        "triggerKeys": [
          "宗门",
          "掌门",
          "长老",
          "师尊",
          "弟子"
        ],
        "priority": 50,
        "constant": false
      }
    ],
    "forbiddenWords": [],
    "softWords": [],
    "forbiddenPatterns": [],
    "tropes": {
      "use": [
        "规则同时产生能力机会、资源冲突与关系变化",
        "具体地貌、建筑、礼俗和感官细节带来探索惊奇"
      ],
      "avoid": [
        "临时新增规则解决核心困境",
        "每卷只换地图、敌人和数值"
      ]
    },
    "outlineHints": [
      "在 readingExperience 确定成长、探索、神话命运、权谋社会或奇异日常的重心，按体验选择设定详略",
      "准备关键能力表：能做什么、条件、不能做什么、使用影响；允许逐步揭示，不在第一章堆全宇宙规则",
      "在分卷 summary 写突破如何改变行动、社会位置与责任；新地图保留旧能力、朋友、经验与承诺的价值",
      "仙侠另写为什么修行、长生对人情和价值的影响；无敌主角可受信息、时间、信任与协调约束",
      "先试写一次利用既定能力作出选择的场景，检验规则是否产生后果与惊奇"
    ],
    "writingRules": [
      "关键解法须有既定能力、资源和前文依据；境界与数值仅按本书采用的设定一致使用",
      "成长改变可以做什么及承担什么，新阶段改变问题性质，不重复从头受辱再升级",
      "力量影响普通人的生产、交通、礼俗与关系，挑与当前主线相关的部分具体呈现",
      "神秘力量可以未知，但不可到结尾才用新规则解决核心问题；新觉醒须有铺垫",
      "语言、称谓与计量依本书时代和场景；都市异能可用手机，不套古典世界禁词"
    ],
    "qc": [
      "核心解法是否有前文依据；不能仅因未解释神秘氛围判违规",
      "成长是否带来新行动与责任，新地图是否抹消旧积累",
      "能力与资源分配是否影响普通人生活，修行目的是否进入人物选择"
    ],
    "targets": {
      "sentenceMean": [
        10,
        20
      ],
      "burstiness": [
        0.45,
        0.9
      ],
      "dialogueRatio": [
        0.3,
        0.6
      ]
    },
    "presetIds": [
      "preset_fast-webnovel",
      "preset_classical-wuxia"
    ]
  },
  {
    "id": "urban",
    "label": "都市 / 现实",
    "aliases": [
      "都市",
      "现实",
      "都市异能",
      "职场",
      "创业"
    ],
    "summary": "都市是生活环境：钱、时间、权限和责任影响选择，可以与异能、科幻或悬疑组合。",
    "entries": [
      {
        "id": "urban:reality",
        "name": "现实约束",
        "kind": "rule",
        "description": "按本书时代与城市核对钱从哪里来、时间怎么分配、谁有决定权、后果由谁承担。都市异能允许已确认的虚构条件，生活约束仍须影响行动。",
        "triggerKeys": [],
        "priority": 70,
        "constant": true
      },
      {
        "id": "urban:workplace",
        "name": "职场与人情",
        "kind": "rule",
        "description": "职业任务、判断依据、执行权限与利益关系须实际影响结果；介入调查有理由、资料有来源、协作有信任基础，不能随意进入所有场所。",
        "triggerKeys": [
          "公司",
          "老板",
          "同事",
          "项目",
          "合同",
          "调查"
        ],
        "priority": 50,
        "constant": false
      }
    ],
    "forbiddenWords": [],
    "softWords": [],
    "forbiddenPatterns": [],
    "tropes": {
      "use": [
        "具体工作问题同时推进能力表现、利益冲突和关系变化"
      ],
      "avoid": [
        "贵人或资源无依据出现解决核心问题",
        "所有对手仅因嫉妒无限作恶"
      ]
    },
    "outlineHints": [
      "明确职场、创业、情感家庭、日常、行业或都市异能方向，给出具体行业、目标与认可对象",
      "在人物 description / intents 写收入来源、时间安排、住房家庭压力、决策权限与责任归属；数字只在帮助理解时使用",
      "准备具体职业任务、资源条件、人物利益与关系；不确定的专业细节先核实，不编造现实证据",
      "试写发现问题 → 判断依据 → 行动 → 结果的职业场景，并让结果改变生计、尊严或关系",
      "异能说明哪些事变容易、哪些责任变复杂；供货、信用、团队、需求与权限继续影响结果"
    ],
    "writingRules": [
      "钱、时间、权限与后果影响人物选择，资源不能凭空出现；不要求每次变化都有账单或具体金额",
      "专业能力通过发现问题、判断、执行与结果体现；技术细节适量但关键判断须可理解",
      "对立人物有利益和顾虑，善意也可冲突；失约、帮助与隐瞒影响后续相处",
      "都市允许已确认的超自然设定，异能只解决其边界内的问题，职业与社会约束继续成立"
    ],
    "qc": [
      "职业、资源、权限与介入理由是否可信；现实断言资料不足时建议核实，不臆造依据",
      "能力是否抹掉供货、信用、团队或法律责任等生活约束",
      "关系是否保留过去行为的影响，不能仅因身份变化重置关系"
    ],
    "targets": {
      "sentenceMean": [
        12,
        24
      ],
      "dialogueRatio": [
        0.3,
        0.55
      ]
    },
    "presetIds": [
      "preset_light-humor",
      "preset_warm-lyrical"
    ]
  },
  {
    "id": "scifi",
    "label": "科幻",
    "aliases": [
      "科幻"
    ],
    "summary": "科学或技术假设持续改变人的处境与社会；边界依据本书假设，不强制只有一个新设定。",
    "entries": [
      {
        "id": "scifi:ceiling",
        "name": "技术上限",
        "kind": "rule",
        "description": "准备技术能做什么、不能做什么、使用条件及影响；规则可逐步揭示，关键解法须有已有假设与前文依据。",
        "triggerKeys": [],
        "priority": 70,
        "constant": true
      },
      {
        "id": "scifi:scale",
        "name": "尺度与通讯",
        "kind": "rule",
        "description": "按本书假设考虑距离、交通、能源与通讯的后果；若有超光速说明其条件与影响，不将现实光速限制强套于已确认虚构规则。",
        "triggerKeys": [
          "星系",
          "光年",
          "跃迁",
          "飞船",
          "通讯",
          "延迟"
        ],
        "priority": 50,
        "constant": false
      }
    ],
    "forbiddenWords": [],
    "softWords": [],
    "forbiddenPatterns": [],
    "tropes": {
      "use": [
        "技术的误用与伦理后果落在具体的人身上"
      ],
      "avoid": [
        "只用新造名词解释一切",
        "最后一刻凭空发明技术解围"
      ]
    },
    "outlineHints": [
      "选择核心科学或技术假设，追问它真的存在时人的行为、组织资源与社会关系怎样改变",
      "准备技术边界与关键后果；多个假设也可成立，但不能只增加术语",
      "试写一次技术条件改变具体人的选择与责任的场景"
    ],
    "writingRules": [
      "技术条件、能力和术语前后一致，现实科学断言先核实",
      "通过具体任务与生活呈现技术后果，关键解法不靠临时发明",
      "先呈现现象再引入必需术语，说明长度服从当前体验"
    ],
    "qc": [
      "假设是否持续改变行动与社会关系",
      "能力是否为方便剧情随需变化，解法是否有依据"
    ],
    "targets": {
      "sentenceMean": [
        14,
        26
      ],
      "burstiness": [
        0.4,
        0.8
      ]
    },
    "presetIds": [
      "preset_hardboiled-scifi",
      "preset_cold-restrained"
    ]
  },
  {
    "id": "mystery",
    "label": "悬疑 / 推理",
    "aliases": [
      "悬疑",
      "推理",
      "心理悬疑",
      "惊悚"
    ],
    "summary": "先区分解谜、危机或心理关系体验；线索公平程度由作品承诺决定。",
    "entries": [
      {
        "id": "mystery:fair-play",
        "name": "公平原则",
        "kind": "rule",
        "description": "若承诺读者参与破案，关键解答须有此前可接触的依据并排除替代解释；不规定凶手出场比例。危机型可早告知凶手，心理型不强制可提前推出唯一答案。",
        "triggerKeys": [],
        "priority": 70,
        "constant": true
      },
      {
        "id": "mystery:clues",
        "name": "线索账",
        "kind": "rule",
        "description": "分别准备真实事件顺序与读者接触顺序；每条关键线索记录出现时机、表面解释、真实解释与排除作用，区分作者/读者/人物知情。误导须有角色行为或处境依据。",
        "triggerKeys": [
          "线索",
          "证据",
          "不在场",
          "凶器",
          "动机"
        ],
        "priority": 50,
        "constant": false
      }
    ],
    "forbiddenWords": [],
    "softWords": [],
    "forbiddenPatterns": [],
    "tropes": {
      "use": [
        "回答疑问后让答案改变处境和人物选择",
        "嫌疑人有独立行动动机，误导也能回看解释"
      ],
      "avoid": [
        "只堆尸体纸条神秘人而不确认任何收获",
        "靠临时证据或能力结案"
      ]
    },
    "outlineHints": [
      "在 readingExperience 明确解谜、危机或心理关系重心，决定隐藏什么、提前告知什么及读者能否参与破案",
      "先规划真实事件时间线：各人行动、所见、误解与留下的结果；另在 beats / 场景规划读者接触信息的顺序，两者不可混同",
      "线索对应成立解释与替代解释排除；动机只说明可疑，识破手法也不自动确定实施者",
      "人物、读者、作者知识分别记录；不可靠叙述须符合心理处境，留可回看理解的裂缝",
      "各阶段确认答案或排除一种解释，答案改变处境并引出新选择；读者猜中不构成临时换答案的理由",
      "试写一条新信息有依据地改变判断的场景；混合异能须先确定稳定的信息边界"
    ],
    "writingRules": [
      "新信息让理解或危险处境实质改变，不强制每章翻线索；阶段问题要有确认收获",
      "参与破案型解答指回读者可接触的证据并处理替代解释，心理型揭晓让前文行为可重新理解",
      "危机型可以先告诉读者凶手，重点写选择与危险逼近；叙述者可以隐瞒、记错或说谎，但须有处境依据和回看裂缝",
      "稳定维护知情边界；读心可只读到对方相信的事，不能关键嫌疑人出现就恰好失灵",
      "不为躲开读者猜测临时换真相，揭晓不能靠此前未建立的能力或证据"
    ],
    "qc": [
      "先核对作品承诺，再判断线索公平；危机/心理型不能强套侦探同知或唯一答案",
      "结论是否有证据，是否混淆动机、手法与实施者，替代解释是否处理",
      "不可靠叙述是否有心理依据与文本裂缝，不能因叙述者撒谎自动报硬冲突",
      "阶段是否更新理解或危机处境；未到揭晓时机不催促揭密"
    ],
    "targets": {
      "sentenceMean": [
        12,
        24
      ],
      "burstiness": [
        0.45,
        0.85
      ]
    },
    "presetIds": [
      "preset_cold-restrained",
      "preset_hardboiled-scifi"
    ]
  },
  {
    "id": "romance",
    "label": "言情 / 青春",
    "aliases": [
      "言情",
      "青春",
      "爱情"
    ],
    "summary": "让偏偏这两个人相爱有独特依据；相处、理解与共同生活持续改变关系。",
    "entries": [
      {
        "id": "romance:stages",
        "name": "关系阶段",
        "kind": "rule",
        "description": "关系的靠近、退开与选择由具体相处产生，不强制相遇到和解的固定阶段；关系成立后仍面对共同生活与独立目标。",
        "triggerKeys": [],
        "priority": 70,
        "constant": true
      },
      {
        "id": "romance:motive",
        "name": "动机链",
        "kind": "rule",
        "description": "吸引与顾虑追溯到经历、价值与具体互动；外貌身份可以吸引，但不能单独承担长期关系的全部解释。",
        "triggerKeys": [
          "喜欢",
          "在意",
          "表白",
          "分手",
          "误会"
        ],
        "priority": 50,
        "constant": false
      }
    ],
    "forbiddenWords": [],
    "softWords": [],
    "forbiddenPatterns": [],
    "tropes": {
      "use": [
        "共同经历与价值选择推进关系"
      ],
      "avoid": [
        "可轻易说清的误会长期维持全部冲突"
      ]
    },
    "outlineHints": [
      "明确为什么偏偏是这两人，各有生活目标与顾虑",
      "规划独特相处、理解变化和共同面对生活的选择，不按固定章数制造/澄清误会",
      "试写一次行动与回应改变关系的场景"
    ],
    "writingRules": [
      "通过具体相处累积吸引、理解与信任，保留失约、帮助和隐瞒的关系记忆",
      "误会难以解释时须有利益、恐惧或处境理由，不能靠轻易说清的事长期拖延",
      "情感成立后写共同生活与选择，情绪可展开也可克制，服从人物声音"
    ],
    "qc": [
      "爱情是否主要靠外貌身份而缺相处依据",
      "长期误会是否只有拒绝解释而无处境理由",
      "关系推进与共同生活是否由行动支持"
    ],
    "targets": {
      "sentenceMean": [
        14,
        28
      ],
      "dialogueRatio": [
        0.3,
        0.55
      ]
    },
    "presetIds": [
      "preset_warm-lyrical",
      "preset_light-humor"
    ]
  },
  {
    "id": "wuxia",
    "label": "历史 / 武侠",
    "aliases": [
      "武侠",
      "历史",
      "架空历史"
    ],
    "summary": "历史保护时代中的信息与资源条件，武侠保护武力、恩仇、承诺与秩序的选择。",
    "entries": [
      {
        "id": "wuxia:jianghu",
        "name": "江湖称谓与辈分",
        "kind": "rule",
        "description": "称呼、身份与关系依本书时代和组织确定，不默认统一辈分称谓；恩仇、承诺和秩序影响行动。",
        "triggerKeys": [],
        "priority": 70,
        "constant": true
      },
      {
        "id": "wuxia:martial",
        "name": "武功体系",
        "kind": "rule",
        "description": "若有武功，记录作用、使用条件与边界，胜负有情境依据；武力不能取代兑现承诺、处理恩怨和秩序冲突。",
        "triggerKeys": [
          "内力",
          "招式",
          "武功",
          "剑法",
          "真气",
          "穴道"
        ],
        "priority": 50,
        "constant": false
      },
      {
        "id": "wuxia:era",
        "name": "时代常识",
        "kind": "rule",
        "description": "历史与架空历史核对人物当时可获得的信息、观念、组织资源和制度；具体史实先核实，架空变化仍有后果，现代知识不能自动解决一切。",
        "triggerKeys": [
          "朝廷",
          "官府",
          "银两",
          "驿站",
          "科举",
          "宵禁"
        ],
        "priority": 50,
        "constant": false
      }
    ],
    "forbiddenWords": [],
    "softWords": [],
    "forbiddenPatterns": [],
    "tropes": {
      "use": [
        "制度和承诺本身构成具体冲突"
      ],
      "avoid": [
        "现代知识无条件解决所有问题",
        "侠义仅停留口号"
      ]
    },
    "outlineHints": [
      "区分历史、架空历史与武侠重点；具体史实按所设时代核实，不拿通用包当史料",
      "历史准备可知信息、组织资源与利益关系，重大改变写清执行条件与后果",
      "武侠准备恩仇、承诺与秩序冲突，试写一次武力能赢却仍须作价值选择的场景"
    ],
    "writingRules": [
      "人物以当时信息、经验与利益行动，现代知识须通过资源和组织执行才产生结果",
      "武力、恩仇、承诺与秩序共同推动行动，侠义在具体选择中体现",
      "称谓、语气与度量依本书时代及混合设定，不将古典禁词用于所有背景"
    ],
    "qc": [
      "时代中的信息、资源与观念是否支持行动",
      "改变是否有实施条件和后果，其他人是否保留自身经验利益",
      "侠义是否进入选择，人物是否只剩武功排名"
    ],
    "targets": {
      "sentenceMean": [
        10,
        22
      ],
      "burstiness": [
        0.45,
        0.85
      ]
    },
    "presetIds": [
      "preset_classical-wuxia",
      "preset_cold-restrained"
    ]
  },
  {
    "id": "daily",
    "label": "日常 / 治愈",
    "aliases": [
      "日常",
      "治愈"
    ],
    "summary": "以陪伴、独特相处和细微生活变化积累价值，保护已建立的情感基调。",
    "entries": [
      {
        "id": "daily:companionship",
        "name": "陪伴与生活变化",
        "kind": "rule",
        "description": "关注人物独特的相处方式与可感知的生活变化；平静不等于无推进，不强制战斗、反转或惨烈事件。",
        "triggerKeys": [],
        "priority": 70,
        "constant": true
      }
    ],
    "forbiddenWords": [],
    "softWords": [],
    "forbiddenPatterns": [],
    "tropes": {
      "use": [
        "具体生活与相处细节累积亲近感"
      ],
      "avoid": [
        "相同互动与笑点长期重复"
      ]
    },
    "outlineHints": [
      "准备日常任务、生活细节与关系习惯，明确读者期待怎样的陪伴与情感安放",
      "试写一次小事让读者多理解一个人或感到生活改善的场景"
    ],
    "writingRules": [
      "相似互动须增加理解、亲近或生活变化，不只重复相同笑点",
      "平静章节可以有满足与余味，重大事件须与此前基调和情感积累相称"
    ],
    "qc": [
      "互动是否反复却未增加关系或体验",
      "是否靠突发极端事件破坏已承诺的基调"
    ],
    "targets": {
      "sentenceMean": [
        12,
        24
      ],
      "dialogueRatio": [
        0.3,
        0.55
      ]
    },
    "presetIds": [
      "preset_warm-lyrical",
      "preset_light-humor"
    ]
  }
];

export const GENRE_PACK_IDS: string[] = GENRE_PACKS.map((p) => p.id);

export function genrePack(id: string): GenrePack | null {
  return GENRE_PACKS.find((p) => p.id === id) ?? null;
}

/** 旧 requirements.genre（单选字符串）→ 题材包 id，用于无需 DB 迁移的向后兼容。 */
export function packIdsForGenre(genre: string): string[] {
  const g = genre.trim();
  if (!g) return [];
  return GENRE_PACKS.filter((p) => p.aliases.includes(g)).map((p) => p.id);
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

export interface MergedGenre {
  packIds: string[];
  labels: string[];
  entries: GenreLoreEntry[];
  forbiddenWords: string[];
  softWords: string[];
  forbiddenPatterns: string[];
  tropes: { use: string[]; avoid: string[] };
  outlineHints: string[];
  writingRules: string[];
  qc: string[];
  targets: GenreTargets;
  /** 多包冲突说明，UI 提示用。 */
  conflicts: string[];
  presetIds: string[];
}

export const EMPTY_GENRE: MergedGenre = {
  packIds: [], labels: [], entries: [], forbiddenWords: [], softWords: [], forbiddenPatterns: [],
  tropes: { use: [], avoid: [] }, outlineHints: [], writingRules: [], qc: [], targets: {}, conflicts: [], presetIds: [],
};

export function isEmptyGenre(m: MergedGenre): boolean {
  return m.packIds.length === 0;
}

const TARGET_KEYS: GenreTargetKey[] = ['sentenceMean', 'burstiness', 'paragraphMean', 'dialogueRatio', 'exclamationPerK', 'ellipsisPerK'];
const TARGET_LABEL: Record<GenreTargetKey, string> = {
  sentenceMean: '句长', burstiness: '句长起伏', paragraphMean: '段长', dialogueRatio: '对白占比', exclamationPerK: '感叹号', ellipsisPerK: '省略号',
};

function uniq(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = x.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 数值靶区间取交集；交集为空时后选的包胜出，并记入 conflicts。 */
export function intersectGenreTargets(packs: ReadonlyArray<Pick<GenrePack, 'label' | 'targets'>>): { targets: GenreTargets; conflicts: string[] } {
  const targets: GenreTargets = {};
  const conflicts: string[] = [];
  for (const key of TARGET_KEYS) {
    let cur: [number, number] | null = null;
    for (const p of packs) {
      const next = p.targets[key];
      if (!next) continue;
      if (!cur) { cur = [next[0], next[1]]; continue; }
      const lo = Math.max(cur[0], next[0]);
      const hi = Math.min(cur[1], next[1]);
      if (lo <= hi) cur = [lo, hi];
      else {
        cur = [next[0], next[1]];
        conflicts.push(`${TARGET_LABEL[key]}区间在所选题材间无交集，采用「${p.label}」的 ${next[0]}–${next[1]}`);
      }
    }
    if (cur) targets[key] = cur;
  }
  return { targets, conflicts };
}

export const MIXED_GENRE_GUIDANCE = {
  outline: '混合题材先在 readingExperience 明确主要体验；在分卷/场景说明不同元素如何依赖并共同推进同一件事。都市是生活环境，幻想是世界条件，悬疑是信息组织，可以叠加；试写同一场景中的职业判断、能力检验、调查与关系后果。',
  writing: '混合题材围绕同一事件共同推进；特殊能力有稳定信息边界，不因关键场景方便而失灵。调查仍有介入理由、权限、信息来源与协作；以本书已确认设定和主要体验为准，不把题材指导当新事实或单一题材禁令。',
  qc: '混合题材核对稳定能力边界、生活权限与信息来源；各元素是否共同推进同一事件，而非轮流暂停；不能仅因都市出现已确认异能报冲突。',
};

/**
 * 合并多个题材包。禁用词/句式/桥段/规则取并集；数值靶区间取交集，交集为空时后选的包胜出并记入 conflicts。
 * `disabled` 里的 lore 条目 id 会被剔除。
 */
export function mergeGenrePacks(ids: readonly string[], disabled: readonly string[] = []): MergedGenre {
  const packs = uniq(ids).map(genrePack).filter((p): p is GenrePack => p !== null);
  if (packs.length === 0) return EMPTY_GENRE;
  const off = new Set(disabled.map((d) => d.trim()).filter(Boolean));

  const entries: GenreLoreEntry[] = [];
  const seenEntry = new Set<string>();
  for (const p of packs) {
    for (const e of p.entries) {
      if (off.has(e.id) || seenEntry.has(e.id)) continue;
      seenEntry.add(e.id);
      entries.push(e);
    }
  }

  const { targets, conflicts } = intersectGenreTargets(packs);

  return {
    packIds: packs.map((p) => p.id),
    labels: packs.map((p) => p.label),
    entries,
    forbiddenWords: uniq(packs.flatMap((p) => p.forbiddenWords)),
    softWords: uniq(packs.flatMap((p) => p.softWords)),
    forbiddenPatterns: uniq(packs.flatMap((p) => p.forbiddenPatterns)),
    tropes: { use: uniq(packs.flatMap((p) => p.tropes.use)), avoid: uniq(packs.flatMap((p) => p.tropes.avoid)) },
    outlineHints: uniq([...(packs.length > 1 ? [MIXED_GENRE_GUIDANCE.outline] : []), ...packs.flatMap((p) => p.outlineHints)]),
    writingRules: uniq([...(packs.length > 1 ? [MIXED_GENRE_GUIDANCE.writing] : []), ...packs.flatMap((p) => p.writingRules)]),
    qc: uniq([...(packs.length > 1 ? [MIXED_GENRE_GUIDANCE.qc] : []), ...packs.flatMap((p) => p.qc)]),
    targets,
    conflicts,
    presetIds: uniq(packs.flatMap((p) => p.presetIds)),
  };
}

/** 显式选择优先；没选过则从旧的 genre 字段推断（无需 DB 迁移）。 */
export function resolveGenrePackIds(req: Pick<NovelRequirements, 'genre' | 'genrePackIds'>): string[] {
  const explicit = (req.genrePackIds ?? []).filter((id) => genrePack(id) !== null);
  return explicit.length > 0 ? explicit : packIdsForGenre(req.genre ?? '');
}

const cache = new Map<string, MergedGenre>();

/** 每章都要用，按 (packIds, disabledLore) 缓存；纯函数，无副作用。 */
export function mergedGenreOf(req: Pick<NovelRequirements, 'genre' | 'genrePackIds' | 'disabledLore'>): MergedGenre {
  const ids = resolveGenrePackIds(req);
  if (ids.length === 0) return EMPTY_GENRE;
  const disabled = req.disabledLore ?? [];
  const key = `${ids.join(',')}|${[...disabled].sort().join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const merged = mergeGenrePacks(ids, disabled);
  cache.set(key, merged);
  return merged;
}

// ---------------------------------------------------------------------------
// 供下游使用的投影
// ---------------------------------------------------------------------------

/** 题材 lore → Setting，直接复用作品层的 lorebook 注入（触发词 + 优先级 + 预算）。 */
export function genreLoreSettings(m: MergedGenre): Setting[] {
  return m.entries.map((e) => ({
    id: e.id, name: e.name, kind: e.kind, description: `【题材创作指导，非本书事实】${e.description}`,
    triggerKeys: [...e.triggerKeys], priority: e.priority, constant: e.constant,
  }));
}

/** 题材靶值 → StyleTargets。题材层一律为软项（hard: []），不触发自动重写。 */
export function genreTargets(m: MergedGenre): StyleTargets {
  return {
    sentenceMean: m.targets.sentenceMean ?? null,
    burstiness: m.targets.burstiness ?? null,
    paragraphMean: m.targets.paragraphMean ?? null,
    dialogueRatio: m.targets.dialogueRatio ?? null,
    exclamationPerK: m.targets.exclamationPerK ?? null,
    ellipsisPerK: m.targets.ellipsisPerK ?? null,
    hard: [],
  };
}

/**
 * 把题材层填进作品的 StyleProfile：只补作品没写的部分（靶区间为 null 的项、空的题材惯例），
 * 作品层已有的值一律不动。profile 为 null 时返回 null——题材包不会凭空造出一个文风档案。
 */
export function applyGenreToProfile(profile: StyleProfile | null, m: MergedGenre): StyleProfile | null {
  if (!profile) return null;
  if (isEmptyGenre(m)) return profile;
  const targets: StyleTargets = { ...profile.targets };
  for (const key of TARGET_KEYS) {
    if (targets[key] === null || targets[key] === undefined) targets[key] = m.targets[key] ?? null;
  }
  const voice = { ...profile.voice };
  if (!voice.genreConventions.text.trim() && m.writingRules.length > 0) {
    voice.genreConventions = { text: m.writingRules.join('；'), evidence: [] };
  }
  return { ...profile, targets, voice };
}

/** 题材包推荐的文风预设排在前面。 */
export function orderPresetsByGenre<T extends { id: string }>(presets: readonly T[], m: MergedGenre): T[] {
  if (isEmptyGenre(m)) return [...presets];
  const rank = new Map(m.presetIds.map((id, i) => [id, i] as const));
  return [...presets].sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
}
