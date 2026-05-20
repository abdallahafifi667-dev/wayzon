/**
 * Geo-Aware Configuration - نظام التكوين الجغرافي العالمي
 *
 * يحدد تلقائياً بناءً على الموقع:
 * - اللغة الأساسية
 * - كلمات البحث عن الخطر
 * - محركات البحث المفضلة
 * - أسئلة الأمان
 * - كلمات مراقبة الفيديو
 * - نمط الخريطة المفضل
 */

const { approximateCountry } = require("../validators/coordinates.validator");

// ============================================================
// 🌍 REGION DEFINITIONS
// ============================================================

const REGIONS = {
  MIDDLE_EAST: [
    "EG",
    "SA",
    "AE",
    "KW",
    "QA",
    "BH",
    "OM",
    "JO",
    "LB",
    "SY",
    "IQ",
    "YE",
    "PS",
  ],
  NORTH_AFRICA: ["EG", "LY", "TN", "DZ", "MA", "SD"],
  GULF: ["SA", "AE", "KW", "QA", "BH", "OM"],
  EUROPE_WEST: ["GB", "DE", "FR", "ES", "IT", "NL", "BE", "PT", "AT", "CH"],
  EUROPE_EAST: ["RU", "UA", "PL", "CZ", "RO", "HU", "BG", "SK"],
  CIS: ["RU", "BY", "KZ", "UA", "UZ", "AZ", "AM", "GE", "MD", "TJ", "TM", "KG"],
  ASIA_EAST: ["CN", "JP", "KR", "TW", "HK", "MO"],
  ASIA_SOUTH: ["IN", "PK", "BD", "LK", "NP"],
  ASIA_SOUTHEAST: ["TH", "VN", "MY", "SG", "ID", "PH", "MM"],
  AMERICAS_NORTH: ["US", "CA", "MX"],
  AMERICAS_SOUTH: ["BR", "AR", "CL", "CO", "PE", "VE"],
  AFRICA_SUB: ["NG", "KE", "ZA", "GH", "ET", "TZ"],
  OCEANIA: ["AU", "NZ"],
};

// ============================================================
// 🗣️ LANGUAGE CONFIGURATIONS
// ============================================================

const LANGUAGE_CONFIG = {
  ar: {
    name: "Arabic",
    nativeName: "العربية",
    direction: "rtl",
    countries: [...REGIONS.MIDDLE_EAST, ...REGIONS.NORTH_AFRICA],
  },
  en: {
    name: "English",
    nativeName: "English",
    direction: "ltr",
    countries: ["US", "GB", "AU", "NZ", "CA", "IE", "SG"],
  },
  ru: {
    name: "Russian",
    nativeName: "Русский",
    direction: "ltr",
    countries: REGIONS.CIS,
  },
  zh: {
    name: "Chinese",
    nativeName: "中文",
    direction: "ltr",
    countries: REGIONS.ASIA_EAST,
  },
  es: {
    name: "Spanish",
    nativeName: "Español",
    direction: "ltr",
    countries: ["ES", "MX", "AR", "CO", "CL", "PE", "VE", "EC", "GT", "CU"],
  },
  fr: {
    name: "French",
    nativeName: "Français",
    direction: "ltr",
    countries: ["FR", "BE", "CH", "CA", "DZ", "MA", "TN", "SN", "CI"],
  },
  de: {
    name: "German",
    nativeName: "Deutsch",
    direction: "ltr",
    countries: ["DE", "AT", "CH"],
  },
  pt: {
    name: "Portuguese",
    nativeName: "Português",
    direction: "ltr",
    countries: ["BR", "PT", "AO", "MZ"],
  },
  tr: {
    name: "Turkish",
    nativeName: "Türkçe",
    direction: "ltr",
    countries: ["TR", "CY"],
  },
  hi: {
    name: "Hindi",
    nativeName: "हिन्दी",
    direction: "ltr",
    countries: ["IN"],
  },
  ja: {
    name: "Japanese",
    nativeName: "日本語",
    direction: "ltr",
    countries: ["JP"],
  },
};

// ============================================================
// ⚠️ DANGER KEYWORDS BY LANGUAGE
// ============================================================

const DANGER_KEYWORDS = {
  en: [
    "danger",
    "warning",
    "emergency",
    "fire",
    "accident",
    "attack",
    "robbery",
    "theft",
    "scam",
    "fraud",
    "unsafe",
    "crime",
    "violence",
    "shooting",
    "explosion",
    "protest",
    "riot",
    "kidnapping",
    "armed",
    "terrorist",
    "bomb",
    "flood",
    "earthquake",
    "storm",
    "help",
    "sos",
  ],
  ar: [
    "خطر",
    "تحذير",
    "طوارئ",
    "حريق",
    "حادث",
    "هجوم",
    "سرقة",
    "نصب",
    "احتيال",
    "غير آمن",
    "جريمة",
    "عنف",
    "إطلاق نار",
    "انفجار",
    "احتجاج",
    "شغب",
    "اختطاف",
    "مسلح",
    "إرهاب",
    "قنبلة",
    "فيضان",
    "زلزال",
    "عاصفة",
    "مساعدة",
    "نجدة",
    "عاجل",
    "حظر تجوال",
    "سطو",
  ],
  ru: [
    "опасность",
    "предупреждение",
    "чрезвычайная ситуация",
    "пожар",
    "авария",
    "нападение",
    "ограбление",
    "кража",
    "мошенничество",
    "небезопасно",
    "преступление",
    "насилие",
    "стрельба",
    "взрыв",
    "протест",
    "беспорядки",
    "похищение",
    "вооружённый",
    "террорист",
    "бомба",
    "наводнение",
    "землетрясение",
    "буря",
    "помощь",
    "SOS",
  ],
  zh: [
    "危险",
    "警告",
    "紧急",
    "火灾",
    "事故",
    "袭击",
    "抢劫",
    "盗窃",
    "诈骗",
    "不安全",
    "犯罪",
    "暴力",
    "枪击",
    "爆炸",
    "抗议",
    "骚乱",
    "绑架",
    "武装",
    "恐怖分子",
    "炸弹",
    "洪水",
    "地震",
    "暴风雨",
    "求助",
  ],
  es: [
    "peligro",
    "advertencia",
    "emergencia",
    "incendio",
    "accidente",
    "ataque",
    "robo",
    "hurto",
    "estafa",
    "fraude",
    "inseguro",
    "crimen",
    "violencia",
    "tiroteo",
    "explosión",
    "protesta",
    "disturbio",
    "secuestro",
    "armado",
    "terrorista",
    "bomba",
    "inundación",
    "terremoto",
    "tormenta",
    "ayuda",
    "socorro",
  ],
  fr: [
    "danger",
    "avertissement",
    "urgence",
    "incendie",
    "accident",
    "attaque",
    "vol",
    "cambriolage",
    "arnaque",
    "fraude",
    "dangereux",
    "crime",
    "violence",
    "fusillade",
    "explosion",
    "manifestation",
    "émeute",
    "enlèvement",
    "armé",
    "terroriste",
    "bombe",
    "inondation",
    "séisme",
    "tempête",
    "aide",
    "secours",
  ],
  de: [
    "Gefahr",
    "Warnung",
    "Notfall",
    "Feuer",
    "Unfall",
    "Angriff",
    "Raub",
    "Diebstahl",
    "Betrug",
    "unsicher",
    "Verbrechen",
    "Gewalt",
    "Schießerei",
    "Explosion",
    "Protest",
    "Aufruhr",
    "Entführung",
    "bewaffnet",
    "Terrorist",
    "Bombe",
    "Überschwemmung",
    "Erdbeben",
    "Sturm",
    "Hilfe",
  ],
  tr: [
    "tehlike",
    "uyarı",
    "acil",
    "yangın",
    "kaza",
    "saldırı",
    "soygun",
    "hırsızlık",
    "dolandırıcılık",
    "güvenli değil",
    "suç",
    "şiddet",
    "silahlı saldırı",
    "patlama",
    "protesto",
    "isyan",
    "adam kaçırma",
    "silahlı",
    "terörist",
    "bomba",
    "sel",
    "deprem",
    "fırtına",
    "yardım",
  ],
  pt: [
    "perigo",
    "aviso",
    "emergência",
    "incêndio",
    "acidente",
    "ataque",
    "roubo",
    "furto",
    "golpe",
    "fraude",
    "inseguro",
    "crime",
    "violência",
    "tiroteio",
    "explosão",
    "protesto",
    "tumulto",
    "sequestro",
    "armado",
    "terrorista",
    "bomba",
    "enchente",
    "terremoto",
    "tempestade",
    "socorro",
  ],
  hi: [
    "खतरा",
    "चेतावनी",
    "आपातकाल",
    "आग",
    "दुर्घटना",
    "हमला",
    "डकैती",
    "चोरी",
    "धोखाधड़ी",
    "असुरक्षित",
    "अपराध",
    "हिंसा",
    "गोलीबारी",
    "विस्फोट",
    "विरोध",
    "दंगा",
    "अपहरण",
    "सशस्त्र",
    "आतंकवादी",
    "बम",
    "बाढ़",
    "भूकंप",
    "तूफान",
    "मदद",
  ],
  ja: [
    "危険",
    "警告",
    "緊急",
    "火災",
    "事故",
    "襲撃",
    "強盗",
    "窃盗",
    "詐欺",
    "安全でない",
    "犯罪",
    "暴力",
    "銃撃",
    "爆発",
    "抗議",
    "暴動",
    "誘拐",
    "武装",
    "テロリスト",
    "爆弾",
    "洪水",
    "地震",
    "嵐",
    "助けて",
  ],
};

// ============================================================
// 🔍 SEARCH ENGINE PREFERENCES BY REGION
// ============================================================

const SEARCH_ENGINES_BY_COUNTRY = {
  // China - Baidu preferred
  CN: ["baidu", "bing"],
  // Russia/CIS - Yandex preferred
  RU: ["yandex", "google", "duckduckgo"],
  BY: ["yandex", "google"],
  KZ: ["yandex", "google"],
  UA: ["google", "yandex"],
  // Middle East - Google + Arabic engines
  SA: ["google", "bing", "duckduckgo"],
  AE: ["google", "bing", "duckduckgo"],
  EG: ["google", "duckduckgo", "bing"],
  // Western world - Google/DuckDuckGo
  US: ["google", "duckduckgo", "bing"],
  GB: ["google", "duckduckgo", "bing"],
  DE: ["google", "duckduckgo", "bing"],
  FR: ["google", "duckduckgo", "bing"],
  // Default
  DEFAULT: ["google", "duckduckgo", "bing"],
};

// ============================================================
// 🗺️ MAP PROVIDER PREFERENCES
// ============================================================

const MAP_PROVIDERS_BY_COUNTRY = {
  CN: ["baidu", "here", "osm"],
  RU: ["yandex", "here", "osm", "google"],
  BY: ["yandex", "here", "osm"],
  KZ: ["yandex", "here", "osm"],
  // Rest of world prioritizes OSM for cost, Google for accuracy
  DEFAULT: ["osm", "here", "google"],
};

// ============================================================
// ❓ SAFETY QUESTIONS BY LANGUAGE
// ============================================================

const SAFETY_QUESTIONS = {
  en: {
    areYouSafe: "Are you safe? Please respond.",
    whereAreYou: "Where are you right now?",
    needHelp: "Do you need help?",
    confirmLocation: "Please confirm your current location.",
    intentionalDeviation:
      "You seem to be off the planned route. Is this intentional?",
    stoppedLong: "You've been stopped for a while. Is everything okay?",
    separatedFromGuide: "You're far from your guide. Is this intentional?",
    options: {
      yes: "Yes",
      no: "No",
      needHelp: "I need help",
      imOkay: "I'm okay",
      exploring: "Just exploring",
      taking_break: "Taking a break",
    },
  },
  ar: {
    areYouSafe: "هل أنت بأمان؟ يرجى الرد.",
    whereAreYou: "أين أنت الآن؟",
    needHelp: "هل تحتاج مساعدة؟",
    confirmLocation: "يرجى تأكيد موقعك الحالي.",
    intentionalDeviation: "يبدو أنك خارج المسار المخطط. هل هذا مقصود؟",
    stoppedLong: "أنت متوقف منذ فترة. هل كل شيء على ما يرام؟",
    separatedFromGuide: "أنت بعيد عن المرشد. هل هذا مقصود؟",
    options: {
      yes: "نعم",
      no: "لا",
      needHelp: "أحتاج مساعدة",
      imOkay: "أنا بخير",
      exploring: "أستكشف فقط",
      taking_break: "آخذ استراحة",
    },
  },
  ru: {
    areYouSafe: "Вы в безопасности? Пожалуйста, ответьте.",
    whereAreYou: "Где вы сейчас находитесь?",
    needHelp: "Вам нужна помощь?",
    confirmLocation: "Пожалуйста, подтвердите ваше текущее местоположение.",
    intentionalDeviation: "Похоже, вы отклонились от маршрута. Это намеренно?",
    stoppedLong: "Вы остановились надолго. Всё в порядке?",
    separatedFromGuide: "Вы далеко от гида. Это намеренно?",
    options: {
      yes: "Да",
      no: "Нет",
      needHelp: "Мне нужна помощь",
      imOkay: "Я в порядке",
      exploring: "Просто осматриваюсь",
      taking_break: "Делаю перерыв",
    },
  },
  zh: {
    areYouSafe: "你安全吗？请回复。",
    whereAreYou: "你现在在哪里？",
    needHelp: "你需要帮助吗？",
    confirmLocation: "请确认你当前的位置。",
    intentionalDeviation: "你似乎偏离了计划路线。这是故意的吗？",
    stoppedLong: "你已经停了一段时间了。一切都好吗？",
    separatedFromGuide: "你离导游很远。这是故意的吗？",
    options: {
      yes: "是",
      no: "否",
      needHelp: "我需要帮助",
      imOkay: "我没事",
      exploring: "只是在探索",
      taking_break: "在休息",
    },
  },
  es: {
    areYouSafe: "¿Estás a salvo? Por favor responde.",
    whereAreYou: "¿Dónde estás ahora?",
    needHelp: "¿Necesitas ayuda?",
    confirmLocation: "Por favor confirma tu ubicación actual.",
    intentionalDeviation:
      "Parece que te has desviado de la ruta planeada. ¿Es intencional?",
    stoppedLong: "Has estado parado por un rato. ¿Todo está bien?",
    separatedFromGuide: "Estás lejos de tu guía. ¿Es intencional?",
    options: {
      yes: "Sí",
      no: "No",
      needHelp: "Necesito ayuda",
      imOkay: "Estoy bien",
      exploring: "Solo explorando",
      taking_break: "Tomando un descanso",
    },
  },
  fr: {
    areYouSafe: "Êtes-vous en sécurité? Veuillez répondre.",
    whereAreYou: "Où êtes-vous maintenant?",
    needHelp: "Avez-vous besoin d'aide?",
    confirmLocation: "Veuillez confirmer votre position actuelle.",
    intentionalDeviation:
      "Vous semblez avoir dévié de l'itinéraire prévu. Est-ce intentionnel?",
    stoppedLong: "Vous êtes arrêté depuis un moment. Tout va bien?",
    separatedFromGuide: "Vous êtes loin de votre guide. Est-ce intentionnel?",
    options: {
      yes: "Oui",
      no: "Non",
      needHelp: "J'ai besoin d'aide",
      imOkay: "Je vais bien",
      exploring: "Je explore seulement",
      taking_break: "Je fais une pause",
    },
  },
  de: {
    areYouSafe: "Sind Sie sicher? Bitte antworten Sie.",
    whereAreYou: "Wo sind Sie gerade?",
    needHelp: "Brauchen Sie Hilfe?",
    confirmLocation: "Bitte bestätigen Sie Ihren aktuellen Standort.",
    intentionalDeviation:
      "Sie scheinen von der geplanten Route abgewichen zu sein. Ist das beabsichtigt?",
    stoppedLong: "Sie stehen schon eine Weile still. Ist alles in Ordnung?",
    separatedFromGuide:
      "Sie sind weit von Ihrem Guide entfernt. Ist das beabsichtigt?",
    options: {
      yes: "Ja",
      no: "Nein",
      needHelp: "Ich brauche Hilfe",
      imOkay: "Mir geht es gut",
      exploring: "Nur erkunden",
      taking_break: "Mache eine Pause",
    },
  },
  tr: {
    areYouSafe: "Güvende misiniz? Lütfen yanıt verin.",
    whereAreYou: "Şu anda neredesiniz?",
    needHelp: "Yardıma ihtiyacınız var mı?",
    confirmLocation: "Lütfen mevcut konumunuzu onaylayın.",
    intentionalDeviation:
      "Planlanan rotadan sapmış görünüyorsunuz. Bu kasıtlı mı?",
    stoppedLong: "Bir süredir duruyorsunuz. Her şey yolunda mı?",
    separatedFromGuide: "Rehberinizden uzaktasınız. Bu kasıtlı mı?",
    options: {
      yes: "Evet",
      no: "Hayır",
      needHelp: "Yardıma ihtiyacım var",
      imOkay: "İyiyim",
      exploring: "Sadece keşfediyorum",
      taking_break: "Mola veriyorum",
    },
  },
  pt: {
    areYouSafe: "Você está seguro? Por favor, responda.",
    whereAreYou: "Onde você está agora?",
    needHelp: "Você precisa de ajuda?",
    confirmLocation: "Por favor, confirme sua localização atual.",
    intentionalDeviation:
      "Você parece ter saído da rota planejada. Isso é intencional?",
    stoppedLong: "Você está parado há um tempo. Está tudo bem?",
    separatedFromGuide: "Você está longe do seu guia. Isso é intencional?",
    options: {
      yes: "Sim",
      no: "Não",
      needHelp: "Preciso de ajuda",
      imOkay: "Estou bem",
      exploring: "Só explorando",
      taking_break: "Fazendo uma pausa",
    },
  },
};

// ============================================================
// 📹 VIDEO SEARCH KEYWORDS BY LANGUAGE
// ============================================================

const VIDEO_SEARCH_TEMPLATES = {
  en: {
    realtimeNews: "{location} live news now",
    trafficAccident: "{location} traffic accident today",
    fireEmergency: "{location} fire emergency",
    crimeReport: "{location} crime incident",
    protestRiot: "{location} protest riot",
    floodStorm: "{location} flood storm weather",
  },
  ar: {
    realtimeNews: "{location} أخبار مباشرة الآن",
    trafficAccident: "{location} حادث مرور اليوم",
    fireEmergency: "{location} حريق طوارئ",
    crimeReport: "{location} حادث جريمة",
    protestRiot: "{location} احتجاج شغب",
    floodStorm: "{location} فيضان عاصفة طقس",
  },
  ru: {
    realtimeNews: "{location} новости сейчас прямой эфир",
    trafficAccident: "{location} авария сегодня",
    fireEmergency: "{location} пожар чрезвычайная ситуация",
    crimeReport: "{location} преступление инцидент",
    protestRiot: "{location} протест беспорядки",
    floodStorm: "{location} наводнение шторм погода",
  },
  zh: {
    realtimeNews: "{location} 实时新闻 现在",
    trafficAccident: "{location} 交通事故 今天",
    fireEmergency: "{location} 火灾 紧急",
    crimeReport: "{location} 犯罪事件",
    protestRiot: "{location} 抗议 骚乱",
    floodStorm: "{location} 洪水 暴风雨 天气",
  },
  es: {
    realtimeNews: "{location} noticias en vivo ahora",
    trafficAccident: "{location} accidente de tráfico hoy",
    fireEmergency: "{location} incendio emergencia",
    crimeReport: "{location} incidente de crimen",
    protestRiot: "{location} protesta disturbios",
    floodStorm: "{location} inundación tormenta clima",
  },
  fr: {
    realtimeNews: "{location} actualités en direct maintenant",
    trafficAccident: "{location} accident de la route aujourd'hui",
    fireEmergency: "{location} incendie urgence",
    crimeReport: "{location} incident criminel",
    protestRiot: "{location} manifestation émeute",
    floodStorm: "{location} inondation tempête météo",
  },
};

// ============================================================
// 🔧 MAIN GEO CONFIG CLASS
// ============================================================

class GeoConfig {
  /**
   * Get full configuration for a location
   * @param {Array} coordinates - [lng, lat]
   * @param {string} fallbackCountry - Fallback country code if detection fails
   * @returns {Object} Complete geo configuration
   */
  static getConfig(coordinates, fallbackCountry = null) {
    const countryCode =
      approximateCountry(coordinates) || fallbackCountry || "US";
    const language = this.getLanguageForCountry(countryCode);

    return {
      country: countryCode,
      language: language,
      isRTL: LANGUAGE_CONFIG[language]?.direction === "rtl",
      dangerKeywords: this.getDangerKeywords(language),
      searchEngines: this.getSearchEngines(countryCode),
      mapProviders: this.getMapProviders(countryCode),
      questions: this.getQuestions(language),
      videoSearchTemplates: this.getVideoSearchTemplates(language),
      region: this.getRegion(countryCode),
    };
  }

  /**
   * Get language code for a country
   */
  static getLanguageForCountry(countryCode) {
    for (const [lang, config] of Object.entries(LANGUAGE_CONFIG)) {
      if (config.countries.includes(countryCode)) {
        return lang;
      }
    }
    return "en"; // Default to English
  }

  /**
   * Get danger keywords for a language (returns array with English as fallback)
   */
  static getDangerKeywords(language) {
    const local = DANGER_KEYWORDS[language] || [];
    const english = DANGER_KEYWORDS.en || [];

    // Merge local + English to catch both
    return [...new Set([...local, ...english])];
  }

  /**
   * Get preferred search engines for a country
   */
  static getSearchEngines(countryCode) {
    return (
      SEARCH_ENGINES_BY_COUNTRY[countryCode] ||
      SEARCH_ENGINES_BY_COUNTRY.DEFAULT
    );
  }

  /**
   * Get preferred map providers for a country
   */
  static getMapProviders(countryCode) {
    return (
      MAP_PROVIDERS_BY_COUNTRY[countryCode] || MAP_PROVIDERS_BY_COUNTRY.DEFAULT
    );
  }

  /**
   * Get localized safety questions
   */
  static getQuestions(language) {
    return SAFETY_QUESTIONS[language] || SAFETY_QUESTIONS.en;
  }

  /**
   * Get video search templates
   */
  static getVideoSearchTemplates(language) {
    return VIDEO_SEARCH_TEMPLATES[language] || VIDEO_SEARCH_TEMPLATES.en;
  }

  /**
   * Get region for a country
   */
  static getRegion(countryCode) {
    for (const [region, countries] of Object.entries(REGIONS)) {
      if (countries.includes(countryCode)) {
        return region;
      }
    }
    return "OTHER";
  }

  /**
   * Build video search queries for a location
   */
  static buildVideoQueries(coordinates, locationName) {
    const config = this.getConfig(coordinates);
    const templates = config.videoSearchTemplates;

    return Object.values(templates).map((template) =>
      template.replace("{location}", locationName),
    );
  }

  /**
   * Check if text contains danger keywords for a location
   */
  static containsDanger(text, coordinates) {
    if (!text) return false;

    const config = this.getConfig(coordinates);
    const normalizedText = text.toLowerCase();

    return config.dangerKeywords.some((keyword) =>
      normalizedText.includes(keyword.toLowerCase()),
    );
  }

  /**
   * Get localized question by type
   * NOTE: All user-facing messages are ALWAYS in English
   * Multilingual support is ONLY for internal search/detection
   */
  static getQuestion(type, coordinates, replacements = {}) {
    // ALWAYS use English for user-facing messages
    const questions = SAFETY_QUESTIONS.en;
    let question = questions[type] || questions.areYouSafe;

    // Apply replacements
    for (const [key, value] of Object.entries(replacements)) {
      question = question.replace(`{${key}}`, value);
    }

    return {
      text: question,
      language: "en", // Always English
      isRTL: false, // English is LTR
      options: questions.options,
    };
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  GeoConfig,
  REGIONS,
  LANGUAGE_CONFIG,
  DANGER_KEYWORDS,
  SEARCH_ENGINES_BY_COUNTRY,
  MAP_PROVIDERS_BY_COUNTRY,
  SAFETY_QUESTIONS,
  VIDEO_SEARCH_TEMPLATES,
};
