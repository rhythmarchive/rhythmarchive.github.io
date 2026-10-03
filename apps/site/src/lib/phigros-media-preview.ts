// Public-safe facts for a development-only media preview. No private paths or production URLs.
export const PREVIEW_MEDIA_ORIGIN = "http://127.0.0.1:4546";
export const mediaItems = [
  {
    "id": "exoplanetary",
    "title": "Exoplanetary Mirage",
    "kind": "unlock",
    "category": "曲目解锁演出",
    "spoiler": false,
    "clips": [
      {
        "label": "完整演出",
        "duration": 40.0,
        "originalBytes": 24469030,
        "originalFile": "18_Exoplanetary_Mirage_Intro_D1_Compressed.mp4",
        "poster": "18_Exoplanetary_Mirage_Intro_D1_Compressed.webp"
      }
    ]
  },
  {
    "id": "entrance",
    "title": "Entrance to the Chaos",
    "kind": "unlock",
    "category": "曲目解锁演出",
    "spoiler": false,
    "clips": [
      {
        "label": "完整演出",
        "duration": 46.03333333333333,
        "originalBytes": 29687667,
        "originalFile": "19_Entrance_to_the_Chaos_Intro_D1_Compressed.mp4",
        "poster": "19_Entrance_to_the_Chaos_Intro_D1_Compressed.webp"
      }
    ]
  },
  {
    "id": "desultory",
    "title": "Desultory Signals",
    "kind": "unlock",
    "category": "曲目与难度演出",
    "spoiler": false,
    "clips": [
      {
        "label": "前奏",
        "duration": 18.0,
        "originalBytes": 11580169,
        "originalFile": "10_ds_unlockIntro_Sound.mp4",
        "poster": "10_ds_unlockIntro_Sound.webp"
      },
      {
        "label": "难度选择",
        "duration": 1.9,
        "originalBytes": 612739,
        "originalFile": "13_ds_unlockDifficulties.mp4",
        "poster": "13_ds_unlockDifficulties.webp"
      },
      {
        "label": "EZ",
        "duration": 17.4,
        "originalBytes": 11822067,
        "originalFile": "15_ds_unlockEZ.mp4",
        "poster": "15_ds_unlockEZ.webp"
      },
      {
        "label": "HD",
        "duration": 17.4,
        "originalBytes": 11948061,
        "originalFile": "14_ds_unlockHD.mp4",
        "poster": "14_ds_unlockHD.webp"
      },
      {
        "label": "IN",
        "duration": 17.4,
        "originalBytes": 11543784,
        "originalFile": "12_ds_unlockIN.mp4",
        "poster": "12_ds_unlockIN.webp"
      },
      {
        "label": "AT",
        "duration": 17.4,
        "originalBytes": 11527396,
        "originalFile": "11_ds_unlockAT.mp4",
        "poster": "11_ds_unlockAT.webp"
      }
    ]
  },
  {
    "id": "phase2",
    "title": "进入第二阶段",
    "kind": "story",
    "category": "章节过场",
    "spoiler": true,
    "clips": [
      {
        "label": "完整过场",
        "duration": 33.6,
        "originalBytes": 22781044,
        "originalFile": "09_ToPhase2.mp4",
        "poster": "09_ToPhase2.webp"
      }
    ]
  },
  {
    "id": "after",
    "title": "推演之后",
    "kind": "story",
    "category": "剧情影像",
    "spoiler": true,
    "clips": [
      {
        "label": "剧情正文",
        "duration": 351.0,
        "originalBytes": 87770263,
        "originalFile": "16_AfterDeductionVideo.mp4",
        "poster": "16_AfterDeductionVideo.webp"
      }
    ]
  },
  {
    "id": "loop",
    "title": "黑洞 · 循环背景",
    "kind": "background",
    "category": "动态背景",
    "spoiler": true,
    "clips": [
      {
        "label": "背景片段",
        "duration": 9.0,
        "originalBytes": 5828429,
        "originalFile": "17_LoopBackground.mp4",
        "poster": "17_LoopBackground.webp"
      }
    ]
  }
] as const;
