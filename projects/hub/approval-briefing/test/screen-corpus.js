#!/usr/bin/env node
/**
 * test/screen-corpus.js
 * Known-answer tests for the local screen (lib/work-order-text-screen.js and
 * its term list): at least 150 strings that MUST hold and at least 100 everyday
 * repair strings that MUST pass, English and Spanish, every category, typed
 * with and without accents. Plus the matching rules, the script and language
 * rules, the credential patterns, the fold, the result shape and the self-test.
 *
 * Run alone:  node projects/hub/approval-briefing/test/screen-corpus.js
 * All text is invented. The slur list is exercised from the terms file itself
 * (never written out here).
 */

const K = require('./test-kit');
const { H, assert, path } = K;
const fs = require('fs');
const screenMod = H.load('lib/work-order-text-screen.js');
const T = H.load('lib/work-order-text-screen-terms.js');
const sharedTerms = require(path.resolve(H.HUB_DIR, 'maintenance-history/lib/protected-class-terms.js'));
const { screenWorkOrderText, CATEGORY_VOCABULARY, SCREEN_VERSION } = screenMod;

const runner = K.makeRunner('Work Order Alert local screen - known-answer corpus');
const { test } = runner;

const screen = (text, title = '') => screenWorkOrderText({ title, description: text });
const isHeld = (text) => screen(text).status === 'held';
const cp = (...codes) => String.fromCodePoint(...codes);

// ════════════════════════════════════════════════════════════════════════
// MUST HOLD (text, a category that must be among those recorded)
// ════════════════════════════════════════════════════════════════════════
const MUST_HOLD = [
  // safety and violence
  ['restraining order against the neighbor', 'safety_violence'],
  ['tenant has a protective order', 'safety_violence'],
  ['she fled a domestic violence situation', 'safety_violence'],
  ['afraid of her ex husband', 'safety_violence'],
  ['tenant is scared of the ex boyfriend', 'safety_violence'],
  ['stalking incident reported', 'safety_violence'],
  ['the abuser knows the address', 'safety_violence'],
  ['victim of assault last month', 'safety_violence'],
  ['threatened the property manager', 'safety_violence'],
  ['police were called to the unit', 'safety_violence'],
  ['sheriff deputies served the door', 'safety_violence'],
  ['called 911 yesterday', 'safety_violence'],
  ['he keeps a handgun in the unit', 'safety_violence'],
  ['gunshot sounds heard last night', 'safety_violence'],
  ['harassment complaint from next door', 'safety_violence'],
  ['estranged husband keeps showing up', 'safety_violence'],
  ['orden de restriccion contra el vecino', 'safety_violence'],
  ['orden de restricción contra el vecino', 'safety_violence'],
  ['violencia doméstica en el departamento', 'safety_violence'],
  ['ella tiene miedo de su ex esposo', 'safety_violence'],
  ['la policía vino anoche', 'safety_violence'],
  ['amenazaron a la inquilina', 'safety_violence'],
  ['acoso del vecino', 'safety_violence'],
  ['maltrato familiar en el segundo piso', 'safety_violence'],
  ['agresión en el estacionamiento', 'safety_violence'],
  ['afraid of her ex-husband', 'safety_violence'],
  // minors
  ['two kids live in the unit', 'minors'],
  ['the tenant has a baby', 'minors'],
  ['toddler locked in the bathroom', 'minors'],
  ['children play in the courtyard', 'minors'],
  ['their daughter goes to the school nearby', 'minors'],
  ['teenage son keeps the gate open', 'minors'],
  ['infant in the house, call first', 'minors'],
  ['newborn at home', 'minors'],
  ['needs a crib assembled', 'minors'],
  ['granddaughter visiting', 'minors'],
  ['babysitter will let you in', 'minors'],
  ['the boy broke the window', 'minors'],
  ['su hijo está en casa', 'minors'],
  ['su hijo esta en casa', 'minors'],
  ['el niño está durmiendo', 'minors'],
  ['el nino esta durmiendo', 'minors'],
  ['la niña tiene escuela', 'minors'],
  ['tiene un bebé recién nacido', 'minors'],
  ['tiene un bebe', 'minors'],
  ['los menores de edad estan solos', 'minors'],
  ['guardería en la casa', 'minors'],
  ['sus hijas estan en la escuela', 'minors'],
  ['mi nieto vive aqui', 'minors'],
  ['niños jugando afuera', 'minors'],
  // health and disability
  ['tenant uses a wheelchair', 'health'],
  ['she has diabetes and needs insulin', 'health'],
  ['oxygen tank in the living room', 'health'],
  ['tenant is pregnant', 'health'],
  ['recovering from surgery', 'health'],
  ['home health aide will be there', 'health'],
  ['caregiver lets you in', 'health'],
  ['has cancer, please be quiet', 'health'],
  ['dialysis on Tuesdays', 'health'],
  ['the tenant is very ill', 'health'],
  ['walker in the hallway', 'health'],
  ['mental health crisis', 'health'],
  ['on medication, sleeps late', 'health'],
  ['asthma and allergies', 'health'],
  ['COVID positive in the unit', 'health'],
  ['tenant is blind', 'disability_health'],
  ['deaf tenant, knock loudly', 'disability_health'],
  ['hospice care at home', 'health'],
  ['tenant has dementia', 'health'],
  ['seizure last week', 'health'],
  ['suicidal statements reported', 'health'],
  ['sobriety program resident', 'health'],
  ['bedridden occupant', 'health'],
  ['needs grab bars installed', 'health'],
  ['tiene diabetes', 'health'],
  ['está enferma desde ayer', 'health'],
  ['silla de ruedas en la entrada', 'health'],
  ['embarazada de ocho meses', 'health'],
  ['el inquilino toma medicamentos', 'health'],
  ['tiene cáncer', 'health'],
  ['depresión y ansiedad', 'health'],
  ['cuidadora en casa', 'health'],
  ['wheel chair ramp', 'health'],
  // immigration and language
  ['ICE agents came by', 'immigration_language'],
  ['tenant fears deportation', 'immigration_language'],
  ['undocumented family', 'immigration_language'],
  ['immigration status question', 'immigration_language'],
  ['speaks Spanish only', 'immigration_language'],
  ['does not speak english', 'national_origin_immigration'],
  ['no english, bring a translator', 'immigration_language'],
  ['Korean speaking tenant', 'immigration_language'],
  ['Mexican family in unit 3', 'immigration_language'],
  ['she is an Asian woman', 'immigration_language'],
  ['a Vietnamese couple', 'immigration_language'],
  ['no habla inglés', 'immigration_language'],
  ['solo habla español', 'immigration_language'],
  ['habla chino', 'immigration_language'],
  ['los agentes de ICE', 'immigration_language'],
  ['la migra vino', 'immigration_language'],
  ['sin papeles', 'immigration_language'],
  ['permiso de trabajo vencido', 'immigration_language'],
  ['necesita un traductor', 'immigration_language'],
  ['la familia mexicana', 'immigration_language'],
  ['la señora negra', 'immigration_language'],
  ['tarjeta verde', 'immigration_language'],
  ['green card holder', 'immigration_language'],
  ['passport required', 'immigration_language'],
  // religion and identity
  ['pastor visits on Sunday', 'religion_identity'],
  ['tenant prays five times a day', 'religion_identity'],
  ['church group meets in the unit', 'religion'],
  ['rabbi will be present', 'religion_identity'],
  ['observes the sabbath', 'religion_identity'],
  ['kosher kitchen only', 'religion_identity'],
  ['Muslim tenant, ramadan', 'religion_identity'],
  ['gay couple', 'sex_gender'],
  ['lesbian tenants', 'sex_gender'],
  ['transgender tenant', 'sex_gender'],
  ['pronouns are she and her', 'religion_identity'],
  ['iglesia cerca de la casa', 'religion_identity'],
  ['testigos de jehová', 'religion_identity'],
  // benefits and income
  ['Section 8 inspection', 'source_of_income'],
  ['housing voucher holder', 'source_of_income'],
  ['tenant gets ssdi', 'benefits_income'],
  ['on welfare', 'source_of_income'],
  ['social worker will attend', 'benefits_income'],
  ['caseworker called', 'benefits_income'],
  ['medi-cal benefits', 'benefits_income'],
  ['low income senior', 'benefits_income'],
  ['unemployment ran out', 'benefits_income'],
  ['HUD inspection Tuesday', 'benefits_income'],
  ['vale de vivienda', 'benefits_income'],
  ['sección 8', 'benefits_income'],
  ['asistencia pública', 'benefits_income'],
  ['trabajadora social', 'benefits_income'],
  // legal and eviction
  ['eviction notice served', 'legal_eviction'],
  ['3 day notice posted', 'legal_eviction'],
  ['3-day notice posted', 'legal_eviction'],
  ['30-day notice to vacate', 'legal_eviction'],
  ['unlawful detainer filed', 'legal_eviction'],
  ['tenant has a lawyer', 'legal_eviction'],
  ['attorney letter received', 'legal_eviction'],
  ['court date next week', 'legal_eviction'],
  ['lawsuit threatened', 'legal_eviction'],
  ['retaliation claim', 'legal_eviction'],
  ['habitability complaint', 'legal_eviction'],
  ['rent withholding', 'legal_eviction'],
  ['small claims hearing', 'legal_eviction'],
  ['desalojo en proceso', 'legal_eviction'],
  ['aviso de desalojo', 'legal_eviction'],
  ['demanda legal', 'legal_eviction'],
  ['audiencia en la corte superior', 'legal_eviction'],
  // arrest and criminal record
  ['he was arrested last week', 'criminal_arrest'],
  ['parole officer visit', 'criminal_arrest'],
  ['sex offender registry', 'criminal_arrest'],
  ['drug activity reported', 'criminal_arrest'],
  ['felony conviction', 'criminal_arrest'],
  ['meth smell in the garage', 'criminal_arrest'],
  ['gang graffiti on the wall', 'criminal_arrest'],
  ['police report filed', 'safety_violence'],
  ['fue arrestado', 'criminal_arrest'],
  ['antecedentes penales', 'criminal_arrest'],
  ['libertad condicional', 'criminal_arrest'],
  ['tráfico de drogas', 'criminal_arrest'],
  // death
  ['tenant passed away', 'death'],
  ['the tenant died on Tuesday', 'death'],
  ['she died last month', 'death'],
  ['funeral on Saturday', 'death'],
  ['next of kin contacted', 'death'],
  ['found dead in the unit', 'death'],
  ['estate of the deceased', 'death'],
  ['homicide investigation', 'death'],
  ['el inquilino murió', 'death'],
  ['falleció la señora', 'death'],
  ['la señora está muerta', 'death'],
  ['velorio mañana', 'death'],
  ['late husband owned the unit', 'death'],
  // financial identifiers
  ['SSN 123-45-6789', 'financial_id'],
  ['social security number is 123 45 6789', 'financial_id'],
  ['card 4111 1111 1111 1111', 'financial_id'],
  ['card 4111-1111-1111-1111 expires soon', 'financial_id'],
  ['routing number 021000021', 'financial_id'],
  ['account number 000123456789', 'financial_id'],
  ['the password is hunter2', 'financial_id'],
  ['date of birth 01/02/1980', 'financial_id'],
  ["driver's license on file", 'financial_id'],
  ['número de seguro social', 'financial_id'],
  ['la contraseña del wifi', 'financial_id'],
  // the shared list (including the seven ordinary words, held by design)
  ['paint the walls white', 'race_color'],
  ['black mold in the bathroom', 'race_color'],
  ['the blind in the bedroom has no cord', 'disability_health'],
  ['diagnosis was a bad capacitor', 'disability_health'],
  ['we diagnosed the leak', 'disability_health'],
  ['too old to repair', 'age'],
  ['too young for the program', 'age'],
  ['123 Church St.', 'religion'],
  ['temple avenue gate', 'religion'],
  ['a black woman answered', 'race_color'],
  ['divorced tenant', 'marital_status'],
  ['widow in unit 4', 'marital_status'],
  ['senior citizen discount', 'age'],
  ['discrimination claim', 'discrimination_general'],
  ['family medical history', 'genetic_information'],
  ['service animal in the unit', 'disability_health'],
  ['has children', 'familial_status'],
  // tricks: invisible characters, look-alikes, folding, separators
  [`preg${cp(0x200B)}nant tenant`, 'sex_gender'],
  [`wheel${cp(0xAD)}chair`, 'health'],
  [`PT${cp(0x2060)}SD`, 'disability_health'],
  [`preg${cp(0xFE0F)}nant`, 'sex_gender'],
  [`preg${cp(0x3164)}nant`, 'sex_gender'],
  [`preg${cp(0xE0100)}nant`, 'sex_gender'],
  [`preg${cp(0x1160)}nant`, 'sex_gender'],
  ['ｗｈｅｅｌｃｈａｉｒ', 'health'],
  ['embaraz' + 'ad' + 'a'.normalize('NFD') + '\u{301}', 'health'],
  ['ex/husband is nearby', 'safety_violence'],
  ['ex_wife is nearby', 'safety_violence'],
  ['non-binary tenant', 'sex_gender'],
  ['domestic-violence shelter', 'safety_violence'],
  ['domestic.violence', 'safety_violence'],
  ['NINO', 'minors'],
  ['Niño', 'minors'],
  ['bebe', 'minors'],
  ['bebé', 'minors'],
  // text the keyword layer cannot read
  ['한국어로 쓴 메모', 'unscreenable_language'],
  ['الماء يتسرب', 'unscreenable_language'],
  ['המים דולפים', 'unscreenable_language'],
  ['Вода течет под раковиной', 'unscreenable_language'],
  ['水龙头漏水', 'unscreenable_language'],
  ['น\u{E49}ำร\u{E31}\u{E48}ว', 'unscreenable_language'],
  ['प\u{93E}न\u{940} टपक रह\u{93E} ह\u{948}', 'unscreenable_language'],
  ['prеgnant', 'unscreenable_language'],
  ['Tumutulo ang gripo sa kusina at basa na ang sahig sa banyo kahapon pa po', 'unscreenable_language'],
  ['Voi nuoc o bon rua chen bi ro ri tu hom qua va nuoc chay ra san nha', 'unscreenable_language'],
  // ── wo-supp-v2 (second fix round): new classes. The glued-word class needs the cleaner's second
  //    reading and is in fix-round-tests.js (R7, R19); the rest is here, on the screen alone.
  // separators for the space (hyphen, slash, underscore, period)
  ['Section-8 tenant', 'source_of_income'],
  ['Section/8 inspection', 'source_of_income'],
  ['section_8 voucher', 'source_of_income'],
  ['Section.8 inspection', 'source_of_income'],
  ['food-stamps tenant', 'source_of_income'],
  ['over-65 tenant', 'age'],
  ['sexual-orientation question', 'sex_gender'],
  ['domestic-partner moved in', 'marital_status'],
  ['Native-American tenant', 'race_color'],
  ['African-American tenant', 'race_color'],
  ['Middle-Eastern tenant', 'race_color'],
  ['reasonable-accommodation request', 'disability_health'],
  ['assistance-animal in unit', 'disability_health'],
  ['genetic-testing results', 'genetic_information'],
  ['source-of-income question', 'source_of_income'],
  ['too-old to repair', 'age'],
  ['domestic_violence situation', 'safety_violence'],
  ['restraining/order served', 'safety_violence'],
  // digits of any script, "N day notice"
  ['a ٣ day notice was posted', 'legal_eviction'],
  ['३० day notice', 'legal_eviction'],
  ['7 day notice posted', 'legal_eviction'],
  ['14-day notice posted', 'legal_eviction'],
  ['a 45 days notice', 'legal_eviction'],
  ['seven day notice', 'legal_eviction'],
  ['60 day notice to quit', 'legal_eviction'],
  ['aviso de 7 dias', 'legal_eviction'],
  ['tenant id ١٢٣-٤٥-٦٧٨٩', 'financial_id'],
  ['card ٤١١١ ١١١١ ١١١١ ١١١١', 'financial_id'],
  // look-alike Latin letters and unassigned code points
  ['tenant is pregnɑnt', 'unscreenable_language'],
  ['muslım tenant', 'unscreenable_language'],
  ['døctor visits', 'unscreenable_language'],
  ['wheełchair user', 'unscreenable_language'],
  ['ᴘʀᴇɢɴᴀɴᴛ tenant', 'unscreenable_language'],
  ['tenant is preg͸nant', 'sex_gender'],
  ['tenant is preg￿nant', 'sex_gender'],
  // meaning-bearing symbols
  ['tenant ♿ ramp', 'disability_health'],
  ['\u{1F930} knock softly', 'sex_gender'],
  ['\u{1F691} at the unit last night', 'disability_health'],
  ['\u{1F693} at the door', 'safety_violence'],
  ['\u{1F54C} tenant leaves at noon', 'religion'],
  ['⚰ unit needs cleaning', 'death'],
  ['\u{1F476} in the unit', 'minors'],
  ['\u{1F1F2}\u{1F1FD} family in unit 3', 'national_origin_immigration'],
  ['\u{1F3F3}\u{1F308} on the balcony', 'sex_gender'],
  // assistance animals, plural identity words, abbreviations, domestic-violence list, TARS list
  ['tenant has an assistance animal', 'disability_health'],
  ['two service dogs live here', 'disability_health'],
  ['el inquilino tiene un perro de servicio', 'disability_health'],
  ['animal de apoyo emocional', 'disability_health'],
  ['the blacks in unit 3', 'race_color'],
  ['hispanics next door', 'race_color'],
  ['the mexicans in unit 3', 'national_origin_immigration'],
  ['los mexicanos de arriba', 'national_origin_immigration'],
  ['a jew lives upstairs', 'religion'],
  ['tenant uses EBT', 'benefits_income'],
  ['TANF recipient', 'benefits_income'],
  ['tenant has AIDS', 'health'],
  ['el inquilino tiene sida', 'health'],
  ['an ambulance came', 'health'],
  ['USCIS letter on the door', 'immigration_language'],
  ['tenant got a DUI', 'criminal_arrest'],
  ['DV situation, change the locks', 'safety_violence'],
  ['she has a TRO against him', 'safety_violence'],
  ['her boyfriend hits her', 'safety_violence'],
  ['bruises on her face', 'safety_violence'],
  ['do not give his ex a key', 'safety_violence'],
  ['su esposo la golpea', 'safety_violence'],
  ['la inquilina tiene moretones', 'safety_violence'],
  ['a woman answered the door', 'sex_gender'],
  ['female tenant in unit 4', 'sex_gender'],
  ['veteran tenant, VA paperwork', 'benefits_income'],
  ['old lady in unit 4', 'age'],
  ['driver license on file', 'financial_id'],
  ['self harm risk', 'health'],
  ['the tenant passed last week', 'death'],
  ['family from Guatemala', 'national_origin_immigration'],
  ['S-8 inspection next week', 'benefits_income'],
  ['domestic issues at home', 'safety_violence'],
  ['she feels unsafe at home', 'safety_violence'],
  ['do not let him in under any circumstances', 'safety_violence'],
  // ── round 3 (wo-supp-v3): direct statements of violence and fear, Spanish for the classes the English list holds,
  // Section 8 and shared phrases with any punctuation, squashed phrases, written forms of "N day notice", more symbols ──
  ['tenant \u{1F150} lettering look-alike', 'unscreenable_language'], ['tenant \u{1F170} lettering look-alike', 'unscreenable_language'],
  ['my husband hit me again', 'safety_violence'],
  ['my boyfriend hits me', 'safety_violence'],
  ['he beat me last night', 'safety_violence'],
  ['his wife beats him', 'safety_violence'],
  ['she hits him when she drinks', 'safety_violence'],
  ['he is hurting her', 'safety_violence'],
  ['he punched me in the hallway', 'safety_violence'],
  ['he slapped her at the door', 'safety_violence'],
  ['he kicked me and left', 'safety_violence'],
  ['he shoved her down the stairs', 'safety_violence'],
  ['he choked me', 'safety_violence'],
  ['he tried to strangle her', 'safety_violence'],
  ['he follows me home', 'safety_violence'],
  ['i am being followed', 'safety_violence'],
  ['he said he would kill me', 'safety_violence'],
  ['she threatened to kill herself', 'safety_violence'],
  ['my ex keeps showing up', 'safety_violence'],
  ['your ex called twice', 'safety_violence'],
  ['the ex keeps coming back', 'safety_violence'],
  ['the ex still has a key', 'safety_violence'],
  ['please do not give him a key', 'safety_violence'],
  ['do not give her a key', 'safety_violence'],
  ['dont give him a key', 'safety_violence'],
  ['don\'t give him a key', 'safety_violence'],
  ['never give him access', 'safety_violence'],
  ['do not allow him in the unit', 'safety_violence'],
  ['keep him out of the building', 'safety_violence'],
  ['keep her out please', 'safety_violence'],
  ['she fled in the night', 'safety_violence'],
  ['fleeing the house', 'safety_violence'],
  ['he has a gun in the unit', 'safety_violence'],
  ['he pulled a gun on her', 'safety_violence'],
  ['me pega cuando toma', 'safety_violence'],
  ['ayer me pego', 'safety_violence'],
  ['su pareja le pego', 'safety_violence'],
  ['la golpeo ayer', 'safety_violence'],
  ['mi ex me acosa', 'safety_violence'],
  ['estoy asustada', 'safety_violence'],
  ['esta huyendo de su esposo', 'safety_violence'],
  ['me va a matar', 'safety_violence'],
  ['la quiere matar', 'safety_violence'],
  ['no lo dejen entrar', 'safety_violence'],
  ['no la dejes entrar', 'safety_violence'],
  ['no le den llave', 'safety_violence'],
  ['no le den la llave', 'safety_violence'],
  ['no me siento segura en casa', 'safety_violence'],
  ['se siente insegura', 'safety_violence'],
  ['tu ex vino otra vez', 'safety_violence'],
  ['me persigue a casa', 'safety_violence'],
  ['me empujo contra la pared', 'safety_violence'],
  ['lo agredio con un cuchillo', 'safety_violence'],
  ['la acosa todos los dias', 'safety_violence'],
  ['tiene una discapacidad', 'health'],
  ['la inquilina tiene discapacidades', 'health'],
  ['no puede caminar sola', 'health'],
  ['tiene dificultad para caminar', 'health'],
  ['tiene artritis', 'health'],
  ['esta en tratamiento', 'health'],
  ['usa audifonos', 'health'],
  ['usa una protesis', 'health'],
  ['esta encinta', 'health'],
  ['dio a luz ayer', 'health'],
  ['va a dar a luz', 'health'],
  ['esta prenada', 'health'],
  ['she gave birth last week', 'health'],
  ['tenant has arthritis', 'health'],
  ['tenant has a bad heart', 'health'],
  ['heart problems since spring', 'health'],
  ['la inquilina es anciana', 'age'],
  ['el anciano vive solo', 'age'],
  ['es una persona mayor', 'age'],
  ['adultos mayores en el edificio', 'age'],
  ['de la tercera edad', 'age'],
  ['la viejita del 3', 'age'],
  ['esta jubilada', 'age'],
  ['los jubilados del edificio', 'age'],
  ['recibe pension', 'age'],
  ['es pensionado', 'age'],
  ['su pension llega el primero', 'age'],
  ['la inquilina es viuda', 'marital_status'],
  ['es viudo', 'marital_status'],
  ['los viudos del piso 2', 'marital_status'],
  ['esta divorciada', 'marital_status'],
  ['se divorcio', 'marital_status'],
  ['widowhood', 'marital_status'],
  ['es madre soltera', 'familial_status'],
  ['padre soltero con dos', 'familial_status'],
  ['the tenant is a single mother', 'familial_status'],
  ['single dad in unit 4', 'familial_status'],
  ['single parents upstairs', 'familial_status'],
  ['mijo juega afuera', 'minors'],
  ['mi mija esta en casa', 'minors'],
  ['la abuelita vive aqui', 'minors'],
  ['su abuelo duerme en la sala', 'minors'],
  ['el nene llora', 'minors'],
  ['las nenas estan solas', 'minors'],
  ['los chiquillos del 4', 'minors'],
  ['recibe ayuda del gobierno', 'benefits_income'],
  ['recibe cupones', 'benefits_income'],
  ['tiene ayuda con la renta', 'benefits_income'],
  ['asistencia de renta', 'benefits_income'],
  ['asistencia para vivienda', 'benefits_income'],
  ['recibe beneficios del gobierno', 'benefits_income'],
  ['tiene residencia permanente', 'immigration_language'],
  ['es residente permanente', 'immigration_language'],
  ['tarjeta de residente vencida', 'immigration_language'],
  ['arreglando papeles', 'immigration_language'],
  ['papeles migratorios', 'immigration_language'],
  ['no tiene documentos', 'immigration_language'],
  ['estatus migratorio', 'immigration_language'],
  ['fue al consulado', 'immigration_language'],
  ['es de Mexico', 'national_origin_immigration'],
  ['vino de El Salvador hace un ano', 'national_origin_immigration'],
  ['nacida en Peru', 'national_origin_immigration'],
  ['son de Guatemala', 'national_origin_immigration'],
  ['tiene un perro de asistencia', 'disability_health'],
  ['perros de asistencia permitidos', 'disability_health'],
  ['perro lazarillo en la unidad', 'disability_health'],
  ['animal de soporte emocional', 'disability_health'],
  ['hizo una denuncia', 'criminal_arrest'],
  ['denunciaron al vecino', 'criminal_arrest'],
  ['vino un reporte policial', 'safety_violence'],
  ['is a nun', 'religion_identity'],
  ['la monja visita', 'religion_identity'],
  ['tenant is behind on rent', 'legal_eviction'],
  ['she is late on rent for 3 months', 'legal_eviction'],
  ['owes back rent', 'legal_eviction'],
  ['esta atrasada con la renta', 'legal_eviction'],
  ['no ha pagado la renta', 'legal_eviction'],
  ['renta vencida desde mayo', 'legal_eviction'],
  ['debe la renta de dos meses', 'legal_eviction'],
  ['note \u2695 on the door', 'disability_health'],
  ['guide \ud83e\uddae in the lobby', 'disability_health'],
  ['\ud83e\udec4 in unit 3', 'sex_gender'],
  ['\ud83d\udc74 lives upstairs', 'age'],
  ['\ud83d\udc75 in 2B', 'age'],
  ['\ud83e\uddd3 at the gate', 'age'],
  ['\ud83d\udd4b nearby', 'religion'],
  ['\ud83d\uded5 on the corner', 'religion'],
  ['\u26e9 on the sign', 'religion'],
  ['Section #8 inspection next week', 'source_of_income'],
  ['Section: 8 inspection', 'source_of_income'],
  ['Section No. 8', 'source_of_income'],
  ['section (8) inspection', 'source_of_income'],
  ['Sec eight inspection', 'source_of_income'],
  ['seccion ocho', 'source_of_income'],
  ['Section "8" inspection', 'source_of_income'],
  ['section ~8 inspection', 'source_of_income'],
  ['sec. viii voucher', 'source_of_income'],
  ['food, stamps tenant', 'source_of_income'],
  ['food|stamps', 'source_of_income'],
  ['public: assistance', 'source_of_income'],
  ['public+assistance', 'source_of_income'],
  ['service & animal', 'disability_health'],
  ['sexual (orientation) question', 'sex_gender'],
  ['marital; status', 'marital_status'],
  ['senior * citizen', 'age'],
  ['skin = color', 'race_color'],
  ['restrainingorder against ex', 'safety_violence'],
  ['domesticviolence incident', 'safety_violence'],
  ['greencard renewal', 'national_origin_immigration'],
  ['sexoffender in unit', 'criminal_arrest'],
  ['tenant passedaway', 'death'],
  ['foodstamps tenant', 'source_of_income'],
  ['mentalhealth issue', 'disability_health'],
  ['serviceanimal in unit', 'disability_health'],
  ['restrain\u200bing\u200border against ex', 'safety_violence'],
  ['3day notice posted', 'legal_eviction'],
  ['3 business day notice', 'legal_eviction'],
  ['3 calendar day notice', 'legal_eviction'],
  ['3 court days notice', 'legal_eviction'],
  ['3 working days notice', 'legal_eviction'],
  ['thirty days written notice', 'legal_eviction'],
  ['3 days of notice', 'legal_eviction'],
  ['notice of 3 days', 'legal_eviction'],
  ['notice (3 days)', 'legal_eviction'],
  ['notice: 3 days', 'legal_eviction'],
  ['(4) day notice posted', 'legal_eviction'],
  ['seventeen day notice', 'legal_eviction'],
  ['fifty day notice', 'legal_eviction'],
  ['ninety nine day notice', 'legal_eviction'],
  ['hundred day notice', 'legal_eviction'],
  ['72 hour notice to vacate', 'legal_eviction'],
  ['24 hours to quit', 'legal_eviction'],
  ['notificacion de 3 dias', 'legal_eviction'],
  ['notificacion de tres dias', 'legal_eviction'],
  ['aviso 3 dias', 'legal_eviction'],
  ['aviso de tres (3) dias', 'legal_eviction'],
  ['3 dias de aviso', 'legal_eviction'],
  ['treinta dias de notificacion', 'legal_eviction'],
  ['aviso de treinta y cinco dias', 'legal_eviction'],
  // ── round 4 (wo-supp-v4): violence done to a named person, first-person Spanish forms, Section 8 jargon,
  // and symbols (that NFKC turns into letters) standing where a space belongs ──
  ['he hits his wife', 'safety_violence'],
  ['the neighbor beats his wife every night', 'safety_violence'],
  ['my dad hits my mom', 'safety_violence'],
  ['my father beats my mother', 'safety_violence'],
  ['he slapped his girlfriend', 'safety_violence'],
  ['he punched his wife', 'safety_violence'],
  ['he choked his girlfriend', 'safety_violence'],
  ['she kicked her husband out and then hit him', 'safety_violence'],
  ['molested', 'safety_violence'],
  ['my uncle touched me', 'safety_violence'],
  ['spanking', 'safety_violence'],
  ['broken nose', 'safety_violence'],
  ['busted lip', 'safety_violence'],
  ['he broke her arm', 'safety_violence'],
  ['she was injured by him', 'safety_violence'],
  ['le pega a su esposa', 'safety_violence'],
  ['empuja a su madre', 'safety_violence'],
  ['patea a su hijo', 'safety_violence'],
  ['soy de Mexico y necesito reparar la ventana', 'national_origin_immigration'],
  ['soy de El Salvador', 'national_origin_immigration'],
  ['naci en Honduras', 'national_origin_immigration'],
  ['nacimos en Mexico', 'national_origin_immigration'],
  ['vengo de Mexico', 'national_origin_immigration'],
  ['vine de Guatemala', 'national_origin_immigration'],
  ['venimos de El Salvador', 'national_origin_immigration'],
  ['no tengo papeles', 'immigration_language'],
  ['no tengo documentos', 'immigration_language'],
  ['no tenemos papeles', 'immigration_language'],
  ['no tenemos documentos', 'immigration_language'],
  ['HQS inspection Friday', 'source_of_income'],
  ['HAP contract', 'source_of_income'],
  ['PHA inspection next week', 'source_of_income'],
  ['EHV tenant', 'source_of_income'],
  ['LIHTC unit', 'source_of_income'],
  ['assisted housing tenant', 'source_of_income'],
  ['tax credit unit', 'source_of_income'],
  ['family self sufficiency', 'source_of_income'],
  ['FSS program', 'source_of_income'],
  ['VA benefits', 'source_of_income'],
  ['\u00A78 tenant', 'source_of_income'],
  ['\u00A7 8 tenant', 'source_of_income'],
  ['food\u2122stamps', 'source_of_income'],
  ['restraining\u2120order', 'safety_violence'],
  ['restraining\u2116order', 'safety_violence'],
  ['Section\u2105 8', 'source_of_income'],
  ['domestic\u2103violence', 'safety_violence'],
  ['food\u33A1stamps', 'source_of_income'],
  ['food\u00BAstamps', 'source_of_income'],
];

// ════════════════════════════════════════════════════════════════════════
// MUST PASS (everyday repair language)
// ════════════════════════════════════════════════════════════════════════
const MUST_PASS = [
  'Replace the kitchen faucet washer',
  'Garbage disposal is jammed and humming',
  'Toilet keeps running after every flush',
  'Water heater pilot light will not stay lit',
  'AC is not cooling, thermostat reads 82',
  'Furnace filter needs to be replaced',
  'Smoke detector chirping in the hallway',
  'Dishwasher not draining',
  'Refrigerator ice maker not working',
  'Dead bolt sticks on the front door',
  'deadbolt',
  'Minor leak under the bathroom sink',
  'minor leak',
  'The outlet is dead in the kitchen',
  'Pump died on the sump basin',
  'The compressor died, unit not cooling',
  'Need a caulk gun to reseal the tub',
  'Heat gun used to remove the old paint',
  'Spanish tile roof has two cracked tiles',
  'Mexican tile in the entry is loose',
  'Violet paint on the accent wall',
  'Replace the window blinds in the bedroom',
  'window blinds',
  'Window screen torn on the back patio',
  'Sprinkler head broken in the front yard',
  'Gate latch is loose, gate code 2040',
  'gate code 2040',
  'Lockbox 1234 is on the side gate',
  'lockbox 1234',
  'Unit 5B garbage disposal jammed',
  'unit 5B',
  'Call John at john@example.com before entering',
  'call John at john@example.com',
  'Call 555-123-4567 to schedule',
  '555-123-4567',
  'fuga menor',
  'Fuga menor en el bano',
  'El armario de la cocina esta roto',
  'armario',
  'Corte de agua en el edificio manana',
  'corte de agua',
  'Sin embargo el techo sigue goteando',
  'sin embargo',
  'La medicion del medidor de gas es incorrecta',
  'medicion',
  'Cambiar el foco del pasillo',
  'La puerta del garaje no cierra bien',
  'Revisar la calefaccion, no calienta',
  'El lavamanos esta tapado',
  'Reparar la cerca del patio trasero',
  'Pintar la pared de la sala',
  'Reemplazar la cerradura de la puerta principal',
  'El inodoro gotea por la base',
  'Dryer vent is clogged with lint',
  'Ceiling fan wobbles at high speed',
  'Replace the cracked floor tile in the bathroom',
  'Paint touch up needed after the plumber',
  'Exterior light is on a timer, replace the photocell',
  'Trim the tree branches near the roof line',
  'Clean gutters and downspouts',
  'Mouse droppings in the garage, set traps',
  'Ants in the kitchen near the sink',
  'Wasp nest above the front door',
  'Garage door opener remote needs a battery',
  'Replace the broken mailbox lock',
  'Carpet in the bedroom needs cleaning',
  'Turnover clean after move out',
  'Rekey all locks before the new move in',
  'Check the circuit breaker, power is out in the bedroom',
  'Shower head dripping, replace the cartridge',
  'Tub drain is slow, snake the line',
  'Hot water takes a long time to arrive',
  'Low water pressure at the kitchen faucet',
  'Gas smell reported near the stove, call the gas company',
  'Stove igniter clicks but the burner does not light',
  'Oven door will not close all the way',
  'Microwave turntable does not spin',
  'Washing machine leaks from the bottom',
  'Install a new smoke alarm',
  'Replace the thermostat batteries',
  'Door hinge squeaks, lubricate',
  'Sliding door is off its track',
  'Window will not stay open',
  'Cracked window pane in the dining room',
  'Patch and paint the drywall hole',
  'Water stain on the ceiling below the upstairs bathroom',
  'Roof leak over the garage, tarp installed',
  'Termite inspection scheduled for Tuesday',
  'Backflow test is due this month',
  'Pool pump making a loud noise',
  'Replace the pool filter cartridge',
  'Backyard fence panel blew down in the wind',
  'Replace the weather stripping on the front door',
  'Light switch sparks when flipped',
  'GFCI outlet will not reset',
  'Bathroom exhaust fan is noisy',
  'Range hood light is out',
  'Toilet seat is cracked',
  'Towel bar fell off the wall',
  'Cabinet door hanging off one hinge',
  'Drawer slide is broken',
  'Counter top chipped near the sink',
  'Clean the dryer lint trap and vent',
  'Annual HVAC service and filter change',
  'Vendor to arrive between 9 and 11 tomorrow',
  'Approved estimate for the water heater replacement',
  'Please send photos after the work is done',
  'Sewer line camera inspection',
  'Hose bib dripping on the side of the house',
  'Landscape lights not turning on',
  'Irrigation timer needs reprogramming',
  'Gutter pulling away from the fascia',
  'Concrete crack in the driveway',
  'Stair railing is wobbly',
  'Garage floor drain is clogged',
  'Attic insulation has been disturbed by rodents',
  'Replace the filter in the refrigerator water line',
  'Bathroom caulk is moldy',
  'Fix the squeaky floor board in the hallway',
  'Pest control follow up, roaches in the pantry',
  'Intercom buzzer not working',
  'Dryer takes two cycles to dry',
  'Replace the stove knobs',
  'Water main shutoff valve is stuck',
  'Smell of sewer gas in the bathroom',
  'Painter needs access to the garage',
  'Please confirm the appointment window',
  'Kitchen faucet drips',
  'Replace hallway light bulb',
  'Back gate latch is loose.',
  'Faucet drips constantly under the sink since Monday morning.',
  // ── wo-supp-v2: ordinary neighbours of the new classes (must still pass)
  '65-inch TV mounted on the wall',
  'Half-inch copper pipe under the sink',
  'Over-the-range microwave not heating',
  'Wall-mounted heater clicks',
  'Non-slip tape on the stairs',
  'Sink-side cabinet door is loose',
  'P-trap leaking, replace the 1/2 inch supply',
  'T-bar ceiling tile is stained',
  'Section 12 of the gate manual',
  'S80 model furnace filter',
  'Male adapter for the hose bib',
  'Female thread on the fitting',
  'Male and female ends of the cable',
  'Service panel is full',
  'Support bracket for the shelf',
  'Service call at 9am',
  'Animal control did not come',
  'Emergency shutoff valve is stuck',
  'Back door lock sticks',
  'Parts from the supplier arrive Tuesday',
  'Passed the final inspection',
  'The inspector passed by the garage',
  'The pipe passed through the wall',
  'Dead outlet in the garage',
  'Give 24 hour notice before entry',
  'Call 3 days before the visit',
  'Notice the crack in the wall',
  'Aviso en la puerta',
  'Cafe señor baño',
  'Unit ٥B garbage disposal jammed',
  'Replace the 2½ inch pipe',
  'Room is 5² ft',
  'Quarter turn ¼ on the valve',
  'Fixed the leak \u{1F527}✅',
  // ── round 3: ordinary neighbours of the new words (English and Spanish repair wording) ──
  'the ball hit the window',
  'kick plate on the door',
  'follow up with the plumber after the inspection',
  'push plate on the gate',
  'kill the water to the unit before you start',
  'kill switch on the disposal',
  'spray to kill them in the attic',
  'the ex-tenant left a mattress in the garage',
  'the extension cord is frayed',
  'external valve is stuck',
  'the flood sensor is beeping',
  'caulk gun and heat gun are in the truck',
  'nail gun trigger is loose',
  'single pole breaker in the panel',
  'single hung window sticks',
  'single pane glass is cracked',
  'single handle faucet drips',
  'birthday party in the clubhouse',
  'heart of the system is the pump',
  'bad connection at the panel',
  'weak water pressure in the shower',
  'the senior technician will come',
  'section of fence 8 feet long',
  'section 80 of the plan',
  'cross section of the duct',
  'section 3 of the gate manual',
  'give 24 hour notice before entry',
  'a 5 day lead time for the part',
  'ready in 5 business days',
  'the 3 day weather forecast is rain',
  '72 hour warranty on the repair',
  'notice posted on the door',
  'national grid meter outside',
  'domestic hot water recirculation',
  'la mayor parte del techo gotea',
  'multa por ruido de la obra',
  'corte de agua en el edificio',
  'el menor ruido se oye',
  'rampa del garaje esta rota',
  'mica de la lampara quebrada',
  'residencia de la calle cinco',
  'papeles del contrato en la oficina',
  'asistencia tecnica del fabricante',
  'ayuda con la instalacion del boiler',
  'planta de tratamiento de agua',
  'golpe en la pared del pasillo',
  'golpeteo en la tuberia',
  'la puerta no cierra bien',
  'el agua sale fria',
  'cambiar la cerradura',
  'revisar el calentador',
  'pintar la sala y el pasillo',
  // ── round 4: ordinary neighbours of the violence, symbol and Section 8 words ──
  'he punched a hole in the wall',
  'someone kicked in the front door',
  'the door was kicked open by the contractor',
  'hit by a car, the gate is bent',
  'truck hit the fence',
  'I hit the mailbox with my car',
  'hit the water main',
  'the beat of the pump is loud',
  'he slapped paint on the wall',
  'pushed the button',
  'grabbed the wrench',
  'the dog attacked the garbage cans',
  'hit the wall near the mother-in-law unit',
  'Call my mother at 5',
  'Dad will meet the plumber',
  'push button on the intercom for the grandmother unit',
  'Brand\u2122 faucet',
  'Roundup\u2120 sprayer',
  'Unit N\u00BA 5',
  'Unit No. 5',
  '25 \u33A1 living room',
  '5\u2103 outside',
  'replace the 2\u00BD inch valve',
  'see \u00A7 12 of the lease',
  'Civil Code \u00A7 1950.5',
  'hap hazard repair',
  'tax credit received for the solar panels',
  'assisted living facility next door',
  'soy el plomero de la compania',
  'pega el azulejo en la pared',
  'es una lastima, no hay agua',
  'pegamento para el piso',
];

// ════════════════════════════════════════════════════════════════════════
test('S1 at least 150 must-HOLD strings, English and Spanish, every category: each holds and records the expected category name', async () => {
  assert.ok(MUST_HOLD.length >= 150, `only ${MUST_HOLD.length}`);
  const seen = new Set();
  for (const [text, cat] of MUST_HOLD) {
    const r = screen(text);
    assert.strictEqual(r.status, 'held', `should hold: ${JSON.stringify(text)}`);
    assert.strictEqual(r.cause, 'local_screen', `cause for ${JSON.stringify(text)}`);
    assert.ok(r.categories.includes(cat), `${JSON.stringify(text)} should record ${cat}, got ${r.categories}`);
    for (const c of r.categories) assert.ok(CATEGORY_VOCABULARY.includes(c));
    seen.add(cat);
  }
  for (const c of T.FEATURE_CATEGORY_KEYS) assert.ok(seen.has(c), `no must-hold string for category ${c}`);
  process.stdout.write(`      (${MUST_HOLD.length} must-hold strings, ${seen.size} categories)\n`);
});

test('S2 at least 100 must-PASS everyday repair strings all pass', async () => {
  assert.ok(MUST_PASS.length >= 100, `only ${MUST_PASS.length}`);
  for (const text of MUST_PASS) {
    const r = screen(text);
    assert.strictEqual(r.status, 'cleared', `should pass: ${JSON.stringify(text)} (got ${r.cause} ${r.categories})`);
  }
  process.stdout.write(`      (${MUST_PASS.length} must-pass strings)\n`);
});

test('S3 the ruling\'s anchor strings, one by one', async () => {
  const pass = ['minor leak', 'fuga menor', 'dead bolt', 'deadbolt', 'the outlet is dead', 'pump died', 'compressor died', 'ice maker not working', 'caulk gun', 'heat gun', 'Spanish tile roof', 'Mexican tile', 'armario', 'corte de agua', 'sin embargo', 'violet paint', 'window blinds', 'medición', 'gate code 2040', 'lockbox 1234', 'unit 5B', 'call John at john@example.com', '555-123-4567'];
  for (const t of pass) assert.strictEqual(screen(t).status, 'cleared', `must pass: ${t}`);
  const hold = ['restraining order', 'orden de restricción', 'orden de restriccion', 'tenant is pregnant', 'embarazada', 'su hijo', 'el niño', 'tenant died', 'tenant passed away', '3 day notice', 'desalojo', 'unlawful detainer', 'he was arrested', 'tiene diabetes', 'wheelchair', 'silla de ruedas', 'afraid of her ex husband', 'ICE agents', 'no habla inglés', 'speaks Spanish only', 'section 8', 'SSN 123-45-6789', `preg${cp(0xFE0F)}nant`, 'paint the walls white', 'black mold', '123 Church St.'];
  for (const t of hold) assert.strictEqual(screen(t).status, 'held', `must hold: ${t}`);
});

test('S4 EVERY term in the list holds when it appears in a sentence (and every stem with letters after it)', async () => {
  let n = 0;
  for (const [cat, entries] of Object.entries(T.TERMS)) {
    for (const { term } of entries) {
      const word = term.replace(/\*/g, '');
      // Stems: a suffix of letters is allowed. Plain terms: the term alone.
      const samples = term.includes('*') ? [word, term.replace(/\*/g, 'x'), term.replace(/\*/g, 'ing')] : [term];
      for (const s of samples) {
        const r = screen(`please note ${s} for this unit`);
        assert.strictEqual(r.status, 'held', `term "${term}" (${cat}) did not hold as "${s}"`);
        assert.ok(r.categories.length >= 1);
        n++;
      }
    }
  }
  process.stdout.write(`      (${n} term placements checked)\n`);
});

test('S5 every slur in the list holds, plainly and with light obfuscation; none is written in this test file', async () => {
  const sub = { a: '@', s: '$', o: '0', i: '1' };
  let n = 0;
  for (const slur of T.SLURS) {
    const variants = new Set([slur, slur.toUpperCase(), `${slur[0]}${slur[0]}${slur[0]}${slur.slice(1)}`, slur.replace(/(.)$/, '$1$1$1')]);
    const swapped = slur.replace(/[aoi]/g, (c) => sub[c]);
    if (swapped !== slur) variants.add(swapped);
    const dollar = slur.replace(/s/g, '$');
    if (dollar !== slur) variants.add(dollar);
    for (const v of variants) {
      const r = screen(`the note said ${v} about someone`);
      assert.strictEqual(r.status, 'held', `slur variant did not hold (list index ${T.SLURS.indexOf(slur)})`);
      assert.ok(r.categories.includes('religion_identity'));
      n++;
    }
  }
  assert.ok(T.SLURS.length >= 60);
  process.stdout.write(`      (${T.SLURS.length} slurs, ${n} variants)\n`);
  // The test file itself must not contain the list.
  const mine = fs.readFileSync(__filename, 'utf8');
  for (const slur of T.SLURS.filter((s) => s.length >= 5)) assert.ok(!mine.includes(slur), 'a slur is written in a test file');
  // Digits inside ordinary words are not slurs.
  assert.strictEqual(screen('replace part 1031 and unit 10').status, 'cleared');
});

test('S6 pair rules: they hold only with their partner words; a lone word does not', async () => {
  const pass = ['the pump died', 'dead battery', 'the engine is dead', 'scooter parked outside', 'he fixed the sink', 'she called the plumber', 'Spanish roof tile', 'Mexican restaurant next door', 'speak to the plumber', 'only the front door', 'the language setting on the thermostat'];
  for (const t of pass) assert.strictEqual(screen(t).status, 'cleared', `a lone word held: ${t}`);
  const hold = [
    ['the tenant died', 'death'], ['tenant is dead', 'death'], ['the owner died last year', 'death'], ['she is dead', 'death'], ['la inquilina esta muerta', 'death'],
    ['speaks spanish', 'immigration_language'], ['spanish only', 'immigration_language'], ['speaking vietnamese', 'immigration_language'], ['habla armenio', 'immigration_language'],
    ['a korean family', 'immigration_language'], ['the chinese couple upstairs', 'immigration_language'], ['mexicana vecina', 'immigration_language'], ['la vecina china', 'immigration_language'],
    ['tenant was very ill', 'health'], ['mobility scooter in the hall', 'health'], ['tenant scooter', 'health'],
  ];
  for (const [t, c] of hold) { const r = screen(t); assert.strictEqual(r.status, 'held', t); assert.ok(r.categories.includes(c), `${t} -> ${r.categories}`); }
  // the window: partner more than 3 words away does not pair
  assert.strictEqual(screen('tenant called the plumber about the sink and then the pump died').status, 'cleared');
  assert.strictEqual(screen('spanish tile on the roof and the front step is the only thing left').status, 'cleared');
});

test('S7 script rule: 3+ letters (or more than 10%) outside Latin hold; accented Latin and symbols do not; a mixed-script word holds', async () => {
  const cl = (t) => screen(t);
  assert.strictEqual(cl('café müller señor naïve façade ångström').status, 'cleared', 'accented Latin letters are Latin');
  assert.strictEqual(cl('replace 10 µF capacitor and ° sensor 5Ω').status, 'held', 'a micro sign / ohm sign next to Latin letters is a mixed-script word');
  assert.strictEqual(cl('fix the sink ° • → ✓ \u{1F6B0}').status, 'cleared', 'symbols and emoji are not letters');
  assert.deepStrictEqual(cl('你好世').categories, ['unscreenable_language']);
  assert.strictEqual(cl('the kitchen sink is leaking under the cabinet 你好').status, 'cleared', 'two non-Latin letters among many Latin letters');
  assert.strictEqual(cl('ab 你好').status, 'held', 'over 10 percent of the letters');
  assert.strictEqual(cl('the sink is leaking badly in the upstairs bathroom and the cabinet а').status, 'cleared', 'one stray letter in 70 is under the limits ...');
  assert.strictEqual(cl('sink lеak').status, 'held', '... but inside a Latin word it is a look-alike trick');
});

test('S8 unrecognised-language rule: 8+ words with under 15% common words hold; normal English and Spanish do not; short text is exempt', async () => {
  const held = [
    'Tumutulo ang gripo sa kusina at basa na ang sahig sa banyo kahapon pa po',
    'Vi du nuoc chay ra tu bon rua chen va san nha rat uot hom qua',
    'A torneira da cozinha vazando muito e molhou todo o chao do banheiro ontem',
  ];
  for (const t of held) { const r = screen(t); assert.strictEqual(r.status, 'held', t); assert.deepStrictEqual(r.categories, ['unscreenable_language']); }
  for (const t of MUST_PASS) assert.strictEqual(screen(t).status, 'cleared', t);
  assert.strictEqual(screen('Zorblax quim narf plub').status, 'cleared', 'under 8 words');
  assert.strictEqual(screen('Zorblax quim narf plub dreb mornt kell vask').status, 'held', '8 words, none known');
  assert.ok(T.COMMON_WORDS.size >= 150, `about 150 words, have ${T.COMMON_WORDS.size}`);
});

test('S9 credential patterns: separated SSN, Luhn-valid card; plain 9-digit job numbers, phone numbers, dates and unit numbers pass', async () => {
  for (const t of ['123-45-6789', '123 45 6789', 'ref 123-45-6789 ok', '123–45–6789']) assert.strictEqual(screen(t).status, 'held', t);
  for (const t of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', '5500 0000 0000 0004', '378282246310005', '3530111333300000']) assert.strictEqual(screen(t).status, 'held', `valid card: ${t}`);
  for (const t of ['4111111111111112', '1234567890123', '123456789', 'job 123456789 approved', '805-555-1234', '(805) 555-1234', '2026-10-16', '10/16/2026 at 9:30', 'unit 12', 'ticket 7001 job 5001', '1 800 555 0100', '12345678901234567890']) {
    assert.strictEqual(screen(t).status, 'cleared', `must pass: ${t}`);
  }
  assert.strictEqual(screenMod._internals.luhnOk('4111111111111111'), true);
  assert.strictEqual(screenMod._internals.luhnOk('4111111111111112'), false);
  assert.strictEqual(screen('gate code 4471, lockbox 9921, alarm 1234, call 805-555-0142 or sam@example.test').status, 'cleared', 'accepted by the owner: these pass');
});

test('S10 folding: case, accents, composed and decomposed letters, curly apostrophes, full-width letters, separators', async () => {
  for (const t of ['WHEELCHAIR', 'WheelChair', 'wheelchair', 'MEDICÁMENTOS', 'medicamentos', 'niño', 'nin\u{303}o', 'NIÑA', 'embarazada', 'EMBARAZADA']) assert.strictEqual(screen(`x ${t} x`).status, 'held', t);
  assert.strictEqual(screen('she doesn’t speak english').status, 'held', 'curly apostrophe');
  assert.strictEqual(screen("she doesn't speak english").status, 'held');
  assert.strictEqual(screen('driver’s license photo').status, 'held');
  assert.strictEqual(screen('megan’s law listing').status, 'held');
  assert.strictEqual(screen('ｒｅｓｔｒａｉｎｉｎｇ ｏｒｄｅｒ').status, 'held', 'full-width letters');
  const f = screenMod._internals;
  assert.strictEqual(f.foldShared('NiÑo D’Art'), "nino d'art");
  assert.strictEqual(f.foldLocal(f.foldShared('Ex-Husband_x/y.z')), 'ex husband x y z');
  assert.strictEqual(f.foldShared('a\u{200B}b'), 'ab');
});

test('S11 boundaries are whole-word and Unicode-aware: a term inside a longer word does not match, accents do not break matching', async () => {
  for (const t of ['grace period', 'trace the wire', 'sonata', 'kidney bean planter', 'painting the wall', 'assistant manager', 'excessive wear', 'vaporizer', 'ladder', 'dispenser', 'courtyard light', 'exceSSIve wear']) {
    assert.strictEqual(screen(t).status, 'cleared', `a term matched inside a longer word: ${t}`);
  }
  assert.strictEqual(screen('bebés en la casa').status, 'held', 'accented plural at a word edge');
  assert.strictEqual(screen('(bebé)').status, 'held', 'punctuation is a boundary');
  assert.strictEqual(screen('¿tiene niños?').status, 'held');
  const src = fs.readFileSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-screen.js'), 'utf8') + fs.readFileSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-screen-terms.js'), 'utf8');
  assert.ok(!/\\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), '\\b is forbidden in the new list code');
});

test('S12 the term file is well-formed: folded, whole-word shape, stems of 5+ letters, known categories, no duplicates within a category', async () => {
  const { foldShared, foldLocal } = screenMod._internals;
  assert.strictEqual(screenMod._internals.compileProblem(), null);
  let n = 0;
  for (const [cat, entries] of Object.entries(T.TERMS)) {
    assert.ok(CATEGORY_VOCABULARY.includes(cat), `unknown category ${cat}`);
    // v2 extends some shared Fair Housing categories too (plural identity words, assistance animals), so any name in the fixed vocabulary is allowed.
    const seen = new Set();
    for (const { term } of entries) {
      n++;
      assert.strictEqual(foldLocal(foldShared(term)), term, `not folded: ${term}`);
      assert.ok(/^[a-z0-9]+\*?(?: [a-z0-9]+\*?)*$/.test(term), `bad shape: ${term}`);
      for (const w of term.split(' ')) if (w.endsWith('*')) assert.ok(/^[a-z]{5,}$/.test(w.slice(0, -1)), `stem under 5 letters: ${term}`);
      assert.ok(!seen.has(term), `duplicate in ${cat}: ${term}`);
      seen.add(term);
    }
  }
  assert.ok(n >= 700, `only ${n} terms`);
  for (const rule of T.PAIR_RULES) for (const w of [...rule.a, ...rule.b]) assert.strictEqual(foldLocal(foldShared(w)), w, `pair word not folded: ${w}`);
  // the vocabulary: the shared keys exactly, plus the feature keys
  assert.deepStrictEqual(T.SHARED_CATEGORY_KEYS.slice().sort(), Object.keys(sharedTerms.CATEGORIES).sort(), 'shared keys match protected-class-terms.js');
  assert.deepStrictEqual(CATEGORY_VOCABULARY.slice(), [...T.SHARED_CATEGORY_KEYS, ...T.FEATURE_CATEGORY_KEYS]);
  assert.strictEqual(CATEGORY_VOCABULARY.length, 22);
  assert.strictEqual(SCREEN_VERSION, `${sharedTerms.TERMS_VERSION}+wo-supp-v4`);
  assert.strictEqual(T.WO_SUPP_VERSION, 'wo-supp-v4');
});

test('S13 the list is code only: no environment variable, database row or file is read by the screen or its terms', async () => {
  for (const f of ['lib/work-order-text-screen.js', 'lib/work-order-text-screen-terms.js']) {
    const code = fs.readFileSync(path.resolve(H.APPROVAL_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/process\.env|require\(['"]fs['"]\)|readFileSync|supabase|\.from\(/.test(code), `${f} reads the environment, a file or a database`);
    assert.deepStrictEqual([...code.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort(),
      f.endsWith('terms.js') ? [] : ['../../maintenance-history/lib/protected-class-terms', './work-order-text-clean', './work-order-text-screen-terms']);
  }
});

test('S14 result shape: fixed fields, categories ordered by the vocabulary, no duplicates, never any text', async () => {
  const r = screenWorkOrderText({ title: 'Secret title', description: 'tenant is pregnant and uses a wheelchair, afraid of her ex husband, Section 8, 3 day notice' });
  assert.deepStrictEqual(Object.keys(r).sort(), ['categories', 'cause', 'common_word_only', 'screen_version', 'status']);
  assert.strictEqual(r.status, 'held'); assert.strictEqual(r.cause, 'local_screen');
  assert.deepStrictEqual(r.categories, CATEGORY_VOCABULARY.filter((c) => r.categories.includes(c)), 'ordered by the vocabulary');
  assert.strictEqual(new Set(r.categories).size, r.categories.length);
  assert.ok(r.categories.length >= 5);
  assert.ok(!JSON.stringify(r).match(/pregnant|wheelchair|Secret|ex husband/i));
  const ok = screenWorkOrderText({ title: 'Faucet', description: 'drips' });
  assert.deepStrictEqual(ok, { status: 'cleared', cause: null, categories: [], common_word_only: false, screen_version: SCREEN_VERSION });
});

test('S15 common_word_only is true only when every match is an ordinary word', async () => {
  const yes = ['paint the walls white', 'black mold', 'the blind is broken', 'diagnosis: capacitor', 'church street', 'temple avenue', 'the school bus stop', 'rehab the kitchen', 'hospital road gate', 'accessible panel', 'gang box', 'work permit for the heater', 'bail out the water', 'booked for Tuesday', '911 Oak Street'];
  for (const t of yes) { const r = screen(t); assert.strictEqual(r.status, 'held', t); assert.strictEqual(r.common_word_only, true, `common only: ${t}`); }
  const no = ['white tenant is pregnant', 'tenant uses a wheelchair', 'paint it white SSN 123-45-6789', 'black and a restraining order', '你好世', 'speaks spanish only'];
  for (const t of no) { const r = screen(t); assert.strictEqual(r.status, 'held', t); assert.strictEqual(r.common_word_only, false, `not common only: ${t}`); }
  assert.strictEqual(screen('replace the faucet').common_word_only, false, 'a clear result is not "common only"');
});

test('S16 title and description are joined and read in full (up to the cap); a hit in either holds; the end of a long text is read', async () => {
  assert.strictEqual(screenWorkOrderText({ title: 'tenant is pregnant', description: 'faucet drips' }).status, 'held');
  assert.strictEqual(screenWorkOrderText({ title: 'faucet', description: 'tenant is pregnant' }).status, 'held');
  const filler = 'replace the faucet washer and clean the sink drain. '.repeat(380); // ~19,760 characters
  assert.strictEqual(screenWorkOrderText({ title: 'x', description: `${filler}tenant uses a wheelchair` }).status, 'held', 'a hit near the 20,000 character cap');
  assert.strictEqual(screenWorkOrderText({ title: 'x', description: filler }).status, 'cleared');
});

test('S17 fail closed: non-string input, missing fields, a blown time budget and a failed self-test all give held / check_error', async () => {
  const closed = (v) => { assert.strictEqual(v.status, 'held'); assert.strictEqual(v.cause, 'check_error'); assert.deepStrictEqual(v.categories, []); assert.strictEqual(v.common_word_only, false); assert.strictEqual(v.screen_version, SCREEN_VERSION); };
  for (const bad of [undefined, null, 'text', 42, [], { title: 'x' }, { description: 'x' }, { title: 1, description: 'x' }, { title: 'x', description: null }, { title: 'x', description: {} }, { title: ['x'], description: 'y' }]) closed(screenWorkOrderText(bad));
  screenMod._setBudgetMsForTesting(-1);
  try { closed(screen('replace the faucet')); } finally { screenMod._setBudgetMsForTesting(); }
  assert.strictEqual(screen('replace the faucet').status, 'cleared', 'and it recovers when the budget is restored');
  screenMod._forceSelfTestForTesting(false);
  try { closed(screen('replace the faucet')); closed(screen('tenant uses a wheelchair')); } finally { screenMod._forceSelfTestForTesting(); }
  assert.strictEqual(screenMod._internals.selfTestStatus().ok, true);
});

test('S18 start-up self-test: 12+ must-hold across categories (English and Spanish) and 12+ must-pass; a wrong answer, a broken list or a corrupted entry fails everything closed with one constant log line', async () => {
  const I = screenMod._internals;
  assert.ok(I.SELF_TEST_MUST_HOLD.length >= 12 && I.SELF_TEST_MUST_PASS.length >= 12);
  assert.ok(I.SELF_TEST_MUST_HOLD.some((t) => /[ñá]|nino|hijo|desalojo|restriccion/.test(t)), 'Spanish must-hold present');
  const termsPath = path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-screen-terms.js');
  const screenPath = path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-screen.js');
  const load = (terms) => { H.reset(); const m = H.loadFresh({ target: screenPath, evict: [screenPath], stubs: { [termsPath]: terms } }); return { m, logs: H.logs.filter((l) => l.includes('self-test FAILED')) }; };
  const copy = (over) => Object.assign({}, T, { TERMS: Object.assign({}, T.TERMS, over) });
  const breakages = {
    'a whole category deleted': copy({ minors: [] }),
    'a wrong "must pass" answer (a repair word added as a term)': copy({ health: T.TERMS.health.concat([{ term: 'faucet', common: false }]) }),
    'a stem shorter than 5 letters': copy({ health: T.TERMS.health.concat([{ term: 'abus*', common: false }]) }),
    'an unfolded entry (accent and capital left in)': copy({ health: T.TERMS.health.concat([{ term: 'Niño', common: false }]) }),
    'an unknown category': Object.assign({}, T, { TERMS: Object.assign({}, T.TERMS, { made_up_category: [{ term: 'zzzz', common: false }] }) }),
  };
  for (const [what, terms] of Object.entries(breakages)) {
    const { m, logs } = load(terms);
    assert.strictEqual(m._internals.selfTestStatus().ok, false, what);
    assert.strictEqual(logs.length, 1, `${what}: exactly one constant log line`);
    for (const text of ['replace the faucet', 'tenant uses a wheelchair', '']) {
      const v = m.screenWorkOrderText({ title: 'x', description: text });
      assert.strictEqual(v.cause, 'check_error', `${what}: every call is a scanner error`);
    }
  }
  const good = load(T);
  assert.strictEqual(good.m._internals.selfTestStatus().ok, true);
  assert.strictEqual(good.logs.length, 0);
});

test('S19 side-effect-free and synchronous: no logging, input not changed, same answer every time, no promise', async () => {
  H.reset();
  const input = Object.freeze({ title: 'Faucet', description: 'tenant uses a wheelchair' });
  const before = JSON.stringify(input);
  const a = screenWorkOrderText(input); const b = screenWorkOrderText(input);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(JSON.stringify(input), before);
  assert.strictEqual(H.logs.length, 0, 'nothing logged');
  assert.ok(!(a instanceof Promise) && typeof a.then !== 'function');
  assert.strictEqual(H.tripwire.calls, 0);
});

test('S20 shared-list reuse is read-only: only scanText and TERMS_VERSION are used from protected-class-terms.js', async () => {
  const code = fs.readFileSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-screen.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(/const \{ scanText, TERMS_VERSION \} = require\('\.\.\/\.\.\/maintenance-history\/lib\/protected-class-terms'\)/.test(code));
  assert.ok(!/protected-class-terms'\)\.|CATEGORIES/.test(code));
});

runner.run();
