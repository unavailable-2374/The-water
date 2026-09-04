/**
 * AI 写作痕迹词表。来源：docs/writing/lexicon/ai-tells.*.json（那两个文件是权威版本，
 * desktop 测试会校验本文件与之一致）。
 */
export interface LexiconPattern { id: string; regex: string; note: string }
export interface LexiconStructural { id: string; method: string; rule: string; note: string }
export interface AiTellsLexicon {
  version: number;
  words: string[];
  wordsSoft: { limitPerK: number; list: string[] };
  patterns: LexiconPattern[];
  structural: LexiconStructural[];
}

export const AI_TELLS_ZH: AiTellsLexicon = {
  "version": 1,
  "words": [
    "赋能",
    "破局",
    "底层逻辑",
    "跃迁",
    "降维打击",
    "弯道超车",
    "认知升级",
    "高维视角",
    "抓手",
    "链路",
    "赛道",
    "护城河",
    "生态位",
    "颗粒度",
    "闭环",
    "对齐",
    "价值感",
    "仪式感",
    "松弛感",
    "钝感力",
    "成长型思维",
    "刻意练习",
    "值得注意的是",
    "不难发现",
    "基于以上分析",
    "综上所述",
    "归根结底",
    "总而言之",
    "毋庸置疑",
    "不可否认",
    "可以说",
    "某种程度上",
    "在很大程度上"
  ],
  "wordsSoft": {
    "limitPerK": 1.5,
    "list": [
      "内卷",
      "共鸣",
      "升华",
      "蜕变",
      "颠覆",
      "沉淀",
      "复盘",
      "不妨",
      "深度",
      "本质上",
      "显然",
      "无疑",
      "深深地",
      "静静地",
      "缓缓",
      "仿佛",
      "似乎",
      "不禁",
      "一丝",
      "一抹",
      "眼底",
      "嘴角勾起",
      "眸子",
      "深邃"
    ]
  },
  "patterns": [
    {
      "id": "not-but",
      "regex": "不是[^。！？]{1,20}而是",
      "note": "不是…而是…"
    },
    {
      "id": "then-now",
      "regex": "以前[^，。]{1,20}[，,]现在",
      "note": "以前…现在…"
    },
    {
      "id": "remember",
      "regex": "记住[，,]?真正重要的是",
      "note": "鸡汤转折"
    },
    {
      "id": "in-this-era",
      "regex": "在这个[^，。]{1,15}的时代",
      "note": "时代套话"
    },
    {
      "id": "let-us",
      "regex": "^让我们",
      "note": "集体号召开头"
    },
    {
      "id": "colon-block",
      "regex": "^[^：:\\n]{1,12}[：:]\\s*$",
      "note": "短标题+冒号分块"
    },
    {
      "id": "triple-parallel",
      "regex": "([^，。；]{2,12}[，；])\\1?[^，。；]{2,12}[，；][^，。；]{2,12}[。！]",
      "note": "机械三段排比（需人工复核）"
    },
    {
      "id": "de-chain",
      "regex": "的[^的，。]{1,6}的[^的，。]{1,6}的",
      "note": "的字连用"
    },
    {
      "id": "eyes-cliche",
      "regex": "(眼底|眸中|眼中)(闪过|划过|掠过)一(丝|抹)",
      "note": "网文眼神套话"
    },
    {
      "id": "mouth-cliche",
      "regex": "嘴角(微微)?(勾起|扬起|上扬)",
      "note": "嘴角套话"
    }
  ],
  "structural": [
    {
      "id": "uniform-paragraphs",
      "method": "stat",
      "rule": "段落字数标准差/均值 < 0.25 且段数 ≥ 6",
      "note": "每段等长"
    },
    {
      "id": "low-burstiness",
      "method": "stat",
      "rule": "句长标准差/均值 < 0.3",
      "note": "句长过于均一"
    },
    {
      "id": "heading-every-para",
      "method": "regex+stat",
      "rule": "≥50% 段落以加粗或短标题开头",
      "note": "段段小标题"
    },
    {
      "id": "emoji-bullets",
      "method": "regex",
      "rule": "[✅❌💡🚀✨🔥📌] 出现 ≥2",
      "note": "emoji 列表"
    },
    {
      "id": "hollow-ending",
      "method": "llm",
      "rule": "结尾段落只有抒情/总结/号召，没有新信息或新动作",
      "note": "升华式结尾"
    },
    {
      "id": "smooth-transitions",
      "method": "llm",
      "rule": "每段都以「然而／与此同时／正因如此」等连接词起头",
      "note": "过渡过于顺滑"
    }
  ]
};

export const AI_TELLS_EN: AiTellsLexicon = {
  "version": 1,
  "words": [
    "delve",
    "tapestry",
    "testament",
    "underscore",
    "moreover",
    "additionally",
    "furthermore",
    "leverage",
    "boast",
    "pivotal",
    "indelible",
    "realm",
    "landscape",
    "navigate",
    "embark",
    "vibrant",
    "bustling",
    "meticulous",
    "multifaceted",
    "paramount",
    "robust",
    "seamless",
    "game-changer",
    "cutting-edge",
    "revolutionary",
    "unlock",
    "harness",
    "foster",
    "elevate"
  ],
  "wordsSoft": {
    "limitPerK": 1.5,
    "list": [
      "very",
      "really",
      "quite",
      "rather",
      "just",
      "actually",
      "basically",
      "essentially",
      "arguably",
      "certainly",
      "undoubtedly",
      "crucial",
      "vital",
      "key",
      "significant",
      "notably",
      "importantly"
    ]
  },
  "patterns": [
    {
      "id": "not-just-but",
      "regex": "\\bnot (just|only|merely) [^.,;]{1,40}\\b but (also )?",
      "note": "not just X but Y"
    },
    {
      "id": "no-no-just",
      "regex": "\\bno [^,.]{1,20}, no [^,.]{1,20}, just\\b",
      "note": "no X, no Y, just Z"
    },
    {
      "id": "testament-to",
      "regex": "\\b(stands|serves) as a testament to\\b",
      "note": "testament cliche"
    },
    {
      "id": "serves-as",
      "regex": "\\bserves as (a|an)\\b",
      "note": "serves as"
    },
    {
      "id": "participle-filler",
      "regex": ",\\s+(highlighting|underscoring|showcasing|emphasizing|reflecting) (its|the|their)\\b",
      "note": "trailing participle filler"
    },
    {
      "id": "in-conclusion",
      "regex": "^\\s*In conclusion,",
      "note": "hollow closer"
    },
    {
      "id": "future-bright",
      "regex": "\\bthe future (is|looks) bright\\b",
      "note": "hollow closer"
    },
    {
      "id": "so-start",
      "regex": "^\\s*So,?\\s",
      "note": "sentence starting with So (write-good)"
    },
    {
      "id": "there-is",
      "regex": "^\\s*There (is|are)\\b",
      "note": "There is/are opener (write-good)"
    },
    {
      "id": "passive",
      "regex": "\\b(is|are|was|were|be|been|being)\\s+\\w+ed\\b",
      "note": "passive voice heuristic (write-good), count ratio"
    },
    {
      "id": "em-dash-overuse",
      "regex": "—",
      "note": "count per 1k words > 3"
    },
    {
      "id": "promo-triplet",
      "regex": "\\b\\w+, \\w+, and (future-proof|scalable|secure|reliable)\\b",
      "note": "marketing triplet"
    },
    {
      "id": "paste-residue",
      "regex": "oaicite|【\\d+†|\\[\\d+\\]\\(#|```\\s*$",
      "note": "copy-paste residue"
    }
  ],
  "structural": [
    {
      "id": "low-burstiness",
      "method": "stat",
      "rule": "sentence length sd/mean < 0.3 (human prose typically 0.45+)",
      "note": "humanizer-skill burstiness"
    },
    {
      "id": "forced-triplets",
      "method": "stat",
      "rule": ">= 3 consecutive parallel items of similar length",
      "note": "forced three-part lists"
    },
    {
      "id": "bold-emoji-headers",
      "method": "regex",
      "rule": "\\*\\*[^*]+\\*\\*\\s*[:：]|[✅❌💡🚀]",
      "note": "textlint no-ai-list-formatting"
    },
    {
      "id": "hype",
      "method": "wordlist",
      "rule": "revolutionary|groundbreaking|first-ever|unprecedented",
      "note": "textlint no-ai-hype-expressions"
    }
  ]
};
