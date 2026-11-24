// The words of the example screens: who speaks, when, the source line and its translations.
// This module is plain data with no imports. The recordings under public/examples/voices were
// made from these words; a line without one is synthesized in the browser instead.

/** The languages the scene is dubbed into. The picture was shot in English. */
export type Lang = "ko" | "ja" | "es" | "fr";

export interface Role {
  readonly id: string;
  readonly name: string;
  /** The name on the role's track, where the full one does not fit. */
  readonly short?: string;
  /** Fundamental of the synthesized stand-in voice, in Hz. */
  readonly pitch: number;
}

export const ROLES: Readonly<Record<string, Role>> = {
  mara: {
    id: "mara",
    name: "Mara",
    pitch: 208,
  },
  ivo: {
    id: "ivo",
    name: "Ivo",
    pitch: 138,
  },
  oda: {
    id: "oda",
    name: "Capt. Oda",
    short: "Oda",
    pitch: 104,
  },
  noor: {
    id: "noor",
    name: "Noor",
    pitch: 198,
  },
  tomas: {
    id: "tomas",
    name: "Tomás",
    pitch: 121,
  },
};

export interface ScriptLine {
  readonly key: string;
  readonly speaker: string;
  /**
   * Where the line starts in the picture, in seconds. The picture is cut to the original
   * performance, so only a longer original line before it moves it later: a dub never does.
   */
  readonly start: number;
  /** Length of the stand-in recording, in seconds. */
  readonly length: number;
  readonly source: string;
  readonly emotion: string;
  readonly text: Readonly<Record<Lang, string>>;
  /** The line is not dubbed: the original performance is kept in every language. */
  readonly kept?: boolean;
}

export const DUB_SCRIPT: readonly ScriptLine[] = [
  {
    key: "01",
    speaker: "mara",
    start: 0.8,
    length: 2.6,
    source: "The tide's coming back early tonight.",
    emotion: "calm",
    text: {
      ko: "오늘 밤은 물때가 일찍 돌아오네.",
      ja: "今夜は潮が早く戻ってくるわ。",
      es: "Esta noche la marea vuelve temprano.",
      fr: "La marée remonte tôt ce soir.",
    },
  },
  {
    key: "02",
    speaker: "ivo",
    start: 3.9,
    length: 2.4,
    source: "Early? The chart says midnight.",
    emotion: "doubtful",
    text: {
      ko: "일찍이라고? 해도에는 자정이라던데.",
      ja: "早く？海図には真夜中って書いてあるよ。",
      es: "¿Temprano? La carta dice medianoche.",
      fr: "Tôt ? La carte dit minuit.",
    },
  },
  {
    key: "03",
    speaker: "mara",
    start: 7.6,
    length: 3,
    source: "Charts don't watch the water. I do.",
    emotion: "dry",
    text: {
      ko: "해도는 바다를 지켜보지 않아. 내가 보지.",
      ja: "海図は海を見ていない。見ているのは私よ。",
      es: "Las cartas no vigilan el agua. Yo sí.",
      fr: "Les cartes ne surveillent pas la mer. Moi, si.",
    },
  },
  {
    key: "04",
    speaker: "ivo",
    start: 11,
    length: 1.3,
    source: "(laughs)",
    emotion: "playful",
    text: {
      ko: "(웃음)",
      ja: "(笑い)",
      es: "(risas)",
      fr: "(rires)",
    },
    kept: true,
  },
  {
    key: "05",
    speaker: "oda",
    start: 11.9,
    length: 3.4,
    source: "Lantern Room, this is the Heron. We've lost the channel markers.",
    emotion: "urgent",
    text: {
      ko: "등대실, 여기는 헤론호. 항로 표지를 놓쳤다.",
      ja: "灯台、こちらヘロン号。航路標識を見失った。",
      es: "Faro, aquí el Heron. Hemos perdido las balizas del canal.",
      fr: "Phare, ici le Heron. Nous avons perdu les balises du chenal.",
    },
  },
  {
    key: "06",
    speaker: "mara",
    start: 16.4,
    length: 2.8,
    source: "Hold your heading. I'm lighting her now.",
    emotion: "resolute",
    text: {
      ko: "침로 유지해. 지금 불을 켤게.",
      ja: "針路を保って。今、灯をともすわ。",
      es: "Mantenga el rumbo. La enciendo ahora.",
      fr: "Gardez le cap. Je l’allume maintenant.",
    },
  },
  {
    key: "07",
    speaker: "ivo",
    start: 19.1,
    length: 2.1,
    source: "The lens is stuck — it won't turn!",
    emotion: "panicked",
    text: {
      ko: "렌즈가 걸렸어, 안 돌아가!",
      ja: "レンズが引っかかってる、回らない！",
      es: "¡La lente está atascada, no gira!",
      fr: "La lentille est coincée, elle ne tourne pas !",
    },
  },
  {
    key: "08",
    speaker: "mara",
    start: 22.2,
    length: 2.8,
    source: "Then we turn it by hand. Together.",
    emotion: "resolute",
    text: {
      ko: "그럼 손으로 돌리자. 같이.",
      ja: "なら手で回しましょう。一緒に。",
      es: "Entonces la giramos a mano. Juntos.",
      fr: "Alors on la tourne à la main. Ensemble.",
    },
  },
  {
    key: "09",
    speaker: "oda",
    start: 27.2,
    length: 3,
    source: "We see you, Lantern Room. We see you.",
    emotion: "relieved",
    text: {
      ko: "보인다, 등대실. 불빛이 보인다.",
      ja: "見えるぞ、灯台。見えている。",
      es: "Los vemos, Faro. Los vemos.",
      fr: "On vous voit, Phare. On vous voit.",
    },
  },
];

export interface ScriptParagraph {
  readonly id: string;
  readonly speaker: string;
  /** The words, with braces around the filler words a transcription pass detected. */
  readonly text: string;
  /** Silence left after it in the first cut, in seconds. */
  readonly gap: number;
}

export const POD_SCRIPT: readonly ScriptParagraph[] = [
  {
    id: "p1",
    speaker: "noor",
    text: "Welcome back to Field Notes. {Um,} today we're standing on a reef at low tide, and I have a microphone in a rock pool.",
    gap: 0.5,
  },
  {
    id: "p2",
    speaker: "tomas",
    text: "And, {uh,} it is louder down there than most people expect. Shrimp, urchins, even the sand makes a sound.",
    gap: 0.45,
  },
  {
    id: "p3",
    speaker: "noor",
    text: "So, {like,} what are we actually hearing right now?",
    gap: 0.6,
  },
  {
    id: "p4",
    speaker: "tomas",
    text: "That crackle is snapping shrimp. {You know,} each snap is a tiny bubble collapsing, faster than a blink.",
    gap: 2.3,
  },
  {
    id: "p5",
    speaker: "noor",
    text: "And you can tell a healthy reef just by listening?",
    gap: 0.45,
  },
  {
    id: "p6",
    speaker: "tomas",
    text: "Pretty much. {Um,} a quiet reef is usually a reef in trouble. Sound is how the young ones find their way home.",
    gap: 1.9,
  },
  {
    id: "p7",
    speaker: "noor",
    text: "{I mean,} that changes how I hear the ocean. Thank you for bringing us out here.",
    gap: 0,
  },
];

/** A recording's ID: the original of a line, or one dubbed take of it. */
export const originalId = (key: string): string => `dx-${key}`;
export const takeId = (lang: Lang, key: string, take: number): string =>
  `${lang}-${key}-${"abc"[take] ?? "a"}`;
export const paragraphId = (id: string): string => `pod-${id}`;
