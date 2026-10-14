// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How far Minecraft's default font moves along for each character: the glyph's own width and one
 * pixel of spacing, one more in bold. Read from the Java Edition 26.3 client's own font, not typed
 * from memory: `assets/minecraft/font/default.json` takes a space from `include/space.json` (4,
 * and 0 for the zero-width non-joiner), then the bitmaps in `include/default.json`, then Unifont.
 * A bitmap glyph's width is its rightmost column with any ink, scaled by the provider's height
 * over the cell's (`BitmapProvider.Definition`), rounded, plus one; bold adds one
 * (`GlyphInfo.getBoldOffset`). Most glyphs move 6; the table holds the ones that don't. Not for
 * drawing: the pages draw with their own pixel face, at the places these widths give.
 */

/** Each bitmap glyph that doesn't move the usual 6 pixels, by how far it moves. */
const BITMAP_ADVANCES: Readonly<Record<number, readonly string[]>> = {
  2: ["!',.:;i|¡¦·ıǀǃʻˌ˙;·і׃ויןᛁᛌᛧ᛬ᴉị⁏ⁱ⏽⸵⹁יִ𐌹"],
  3: ['`l´ìíįĺļɩɭ\u0327ίιՙ՚՛՝լ׳᛫ᛵᶅᶖḷἱί‘’‚•′‵⁽⁾₍₎ꞁוֹ'],
  4: [
    '"()*I[]t{}¨\u00ad¹ÌÍÎÏîïĪīĮİľŀţŧſƖƗƚƫƭǁǏǐțȴɨɪʇʈΙΪϊІЇїӀ՜՞׆זנװױײ჻ჼᚨ',
    'ᚭᚮᚲᚽᚿᛂᛆᛊᛍᛐᛓᛙᛚḮḯḹḻḽṫṭṯṱẗẛỈỉỊἰὶῑῒΐῙ‐‑‹›‼⁎⁑⁒⁺⁻⁼₁₊₋₌∥⋆⏴⏵⏸◘◦♀♩♭♮ײַ',
    'וּ',
  ],
  5: [
    '<>fkª°²³ºĨĩĬĭĳķĸłťƙǩȊȋȶɟɬʞκгкѓќҕӄӷԼՒէւג״ჯᚠᚡᚦᚧᚩᚪᚫᚱᚳᚴᚵᚹᛈᛑᛒᛔᛕᛛᛩ',
    'ᛴᶂḟḬḭḱḳḵẜẝỽἶἷῐῖῗῘ“”„″‶⁊⁰⁴⁵⁶⁷⁸⁹ⁿ₀₂₃₄₅₆₇₈₉∁⌡▌●ꝛכּ',
  ],
  7: [
    '@~«¶»ÐĐđħŁƀƄƅƇƈƉƑƓƝƬƳǤǥȽɃɇɈɉɊɋɌɍɖɗɠɲɳɻʄʆʐʛʠʮσϔЊЋДЦЪдщъыђњћѢѣ',
    'ѴѵѶѷҊҋҌҍҒҗҚҞҠҢңҤҥҨҩҲҳҵҶҷӅӆӉӊӍӎӹӺԆԇԎԏԤԥԦԧԨԩԬԭԮԯԳԴԹԺԽՂՄՌգդզժխղ',
    'մնվքևֈႫႯჱᛃᛟᶁᶃᶆᶇᶍᶎᶏᶐᶑᶒᶓᶕᶗᶙỻỿἅἸἾἿῚΊ–‴‷⁋₣₫€₭₺₽₾⅟⇵√∝≈≡≢⏩⏪⏯▶▷◀◁⛄✔',
    '✘❌ⱥⴁⴂⴆⴎⴏⴝꚀꚁꚈꚉꚊꚋꚎꚒꚓꚗꜩꞕꞨꟆﬂ🔥🪓',
  ],
  8: [
    '¤©®¼½¾ďĦŉƁƊƠơƢƣƤƯưƴǉȡȵɄɎɏɚɝɷʉʧʪʫʯΆΈΉΌΎΏωώЂЉЖФШЫЮюљҴҼҽҾҿӁӜӸԄԅ',
    'տփႡႢႥႦႧႪႭႮႰႳႻჀჅლᛠᛢᛪᛳᵬᵭᵯᵰᵱᵲᵳᵴỚớỜờỞởỠỡỢợỨứỪừỬửỮữỰựỺἻἽὠὡὢὣὤὥὦὧὼ',
    'ώᾠᾡᾢᾣᾤᾥᾦᾧῲῳῴῶῷ…‰※⁂⁈⁉₦₩₪₱₳₴₷₻℗⅙⅚←→⇄∀∅∛∜∞≔⌀⌂⌘⌚⌛⌠⏭⏮⏳⏻⏼║╖╗╜╝╢╣░◎',
    '☂☃☄★☆☈☔☠☻♫♬⚀⚁⚂⚃⚄⚅⚐⚑⚓⚔⚗⛨✂✉✎❄❤⧈⭐⭘⯪⯫ⱢⱱꜨﬀ�🔔🛡🧪🪣',
  ],
  9: [
    'ƕǶʦʨЩҖҦҧԂԃԈԉԊԋԔԕԖԗԠԡԢԣᵺἈἉἎἏἘἙἨἩἮἯἺἼὈὉὙὟὨὩὮᾈᾉᾎᾏᾘᾙᾞᾟᾨᾩᾮᾺΆῈΈῊΉῪ',
    'ΎῬῸΌῺΏ—‱⁗™⅐⅑⅓⅔⅕⅖⅗⅛⅜⅝⅞↉↔⇏⇒⇔─┌└├┬┴┼═╒╓╔╘╙╚╞╟╠╤╥╦╧╨╩╪╫╬▀▄█▐▒▓☀☁',
    '☽⛈⛏ꚅꚖꜹꜻꜽﬃ🌊🌧🍖🎣🏹🔱🗡',
  ],
  10: [
    'ÆæŒœǄǅǆǇǈǊǋǌǢǣǱǲǳǼǽȸȹɶʣʤʥʩϓӔӕԘԙԪԫᴂᴔᵫἊἋἌἍἚἛἜἝἪἫἬἭἹὊὋὌὍὛὝὪὫὬὭὯ',
    'ᾊᾋᾌᾍᾚᾛᾜᾝᾪᾫᾬᾭᾯ⁇₧₨₯№ℹ⅒⅘①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳ⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈ',
    'ⓉⓊⓋⓌⓍⓎⓏⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ⓪☐☑☒☜☞☮☯⚠ꚄꜲꜳꜴꜵꜶꜷꜸꜺꜼꝎꝏꭣﬄﬆﬓﬔﬕ',
    'ﬖﬗ',
  ],
}

const ADVANCE = new Map<number, number>(
  Object.entries(BITMAP_ADVANCES).flatMap(([advance, rows]) =>
    [...rows.join('')].map((char) => [char.codePointAt(0) ?? 0, Number(advance)] as const),
  ),
)
ADVANCE.set(' '.codePointAt(0) ?? 0, 4)
ADVANCE.set(0x200c, 0)

/** What the bitmaps leave to Unifont: its double-width glyphs, for Chinese, Japanese and Korean, move 9. */
const UNIFONT_WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3fffd}]/u

/** How many pixels a character moves the text along in the game's default font. */
export function glyphAdvance(char: string, bold: boolean): number {
  const usual = UNIFONT_WIDE.test(char) ? 9 : 6
  return (ADVANCE.get(char.codePointAt(0) ?? 0) ?? usual) + (bold ? 1 : 0)
}
