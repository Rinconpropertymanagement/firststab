/**
 * lib/work-order-text-screen-terms.js
 *
 * The feature-local word lists for the Work Order Alert description screen
 * (lib/work-order-text-screen.js). Version string: 'wo-supp-v4' (v1, plus the
 * v2 and v3 additions, plus the v4 additions below; nothing was removed or loosened).
 *
 * WHAT THIS IS. A plain code asset, reviewed like protected-class-terms.js.
 * The shared list (maintenance-history/lib/protected-class-terms.js) covers
 * the Fair Housing categories. This file adds what that list does not:
 * safety and violence, minors, health, immigration and language, religion and
 * identity (including slurs), benefits, legal and eviction, arrest and
 * criminal record, death, and financial identifiers. It also holds the
 * "unrecognised language" word list. Asimov's ruling (the "supplementary
 * terms") is the source for the categories and the representative terms;
 * inflections, plurals and spellings were expanded here.
 *
 * EVERY MATCH IS A HOLD. There is no allow-list, no rescue and no
 * per-instance exception. Entries marked [common] are everyday repair,
 * address or Spanish words (white, school, rehab, ...). They hold like any
 * other entry. The mark only feeds one yes/no counter (common_word_only) so
 * the shadow week can show how many holds are probably false alarms.
 *
 * FORMAT RULES (checked by the screen at load time, and by the tests):
 *   - Terms are stored ALREADY FOLDED: lowercase, no accents (n-tilde is
 *     written n, e-acute is written e), no hyphens, periods, slashes,
 *     underscores or apostrophes (all of these are spaces, so "megan's law"
 *     is "megan s law"), words separated by single spaces.
 *   - A trailing * on a word means "any letters may follow" (a stem). Stems
 *     need 5 or more letters before the *. Shorter stems are written out in
 *     full (abuse, abused, abuser, ...).
 *   - Matching is whole-word with Unicode-aware boundaries. Never bare
 *     substring matching and never \b (it does not see accented letters).
 *   - A line ending in " [c]" is marked common.
 *   - "pair" rules (PAIR_RULES) match only when a word from list A and a word
 *     from list B are close together.
 *
 * CHANGE CONTROL (work-order-note-alerts-description-governance-review.md,
 * GOVERNANCE.md Rule 6): ADDING terms is a Standard change (Peter's OK, bump
 * WO_SUPP_VERSION). REMOVING or LOOSENING any term, adding an allow-phrase or
 * a rescue, is a Critical change: Peter's explicit OK, Asimov re-review and a
 * fresh 7-day shadow week on the new version. This list is code only. It is
 * never read from an environment variable, a database row or any runtime
 * setting.
 *
 * The slur list below exists only so those words HOLD the block. It is kept
 * in this file and nowhere else (not in tests, not in documents).
 */

'use strict';

// v2 (2026-10-16 second fix round), v3 (third) and v4 (fourth): ADDITIONS ONLY,
// as Standard changes. See TERMS_V2_ADDITIONS, TERMS_V3_ADDITIONS,
// TERMS_V4_ADDITIONS, the pair-rule additions, SYMBOLS and SQUASHED_PHRASES
// below. Tests compare the live lists with snapshots of v1, v2 (as built in
// ce30374) and v3 (as built in 2ab3d53) and fail if any entry of any of them
// is missing or changed. v2 and v3 were never deployed or shadow-run; they are
// kept as named steps so the diff Peter is shown is v1 -> v2 -> v3 -> v4.
const WO_SUPP_VERSION = 'wo-supp-v4';

// Keys of maintenance-history/lib/protected-class-terms.js CATEGORIES, written
// out so this file does not need to load that one. A test proves they match.
const SHARED_CATEGORY_KEYS = [
  'race_color', 'religion', 'sex_gender', 'national_origin_immigration',
  'familial_status', 'disability_health', 'source_of_income', 'marital_status',
  'age', 'genetic_information', 'discrimination_general',
];

const FEATURE_CATEGORY_KEYS = [
  'safety_violence', 'minors', 'health', 'immigration_language',
  'religion_identity', 'benefits_income', 'legal_eviction', 'criminal_arrest',
  'death', 'financial_id', 'unscreenable_language',
];

// The ONLY category names that can ever be recorded or logged.
const CATEGORY_VOCABULARY = Object.freeze([...SHARED_CATEGORY_KEYS, ...FEATURE_CATEGORY_KEYS]);

// The seven shared-list words that are ordinary repair or address words, plus
// three more the ruling marked [common]. Used only for common_word_only.
const SHARED_COMMON_TERMS = new Set([
  'white', 'black', 'blind', 'diagnosis', 'diagnosed', 'too old', 'too young for',
  'church', 'temple', 'depression',
]);

/** One term per line; a trailing " [c]" marks it common. Blank lines ignored. */
function lines(block) {
  return block.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const common = l.endsWith(' [c]');
    return { term: common ? l.slice(0, -4).trim() : l, common };
  });
}

const TERMS_V1 = {
  // ─── 1. safety and violence ──────────────────────────────────────────────
  // Not bare: gun (caulk gun, heat gun), arma (armario, armar), viol* (violeta).
  safety_violence: lines(`
    domestic violence
    domestic abuse
    domestic dispute
    domestic disturbance
    restraining order*
    protective order*
    protection order*
    stay away order*
    order of protection
    orders of protection
    stalk*
    abuse
    abused
    abuser
    abusers
    abuses
    abusing
    abusive
    battered
    assault*
    rape
    raped
    rapes
    raping
    rapist*
    harass*
    threat*
    violen*
    victim*
    afraid of
    scared of
    terrified
    frightened
    fearful
    fears for
    safe house
    safehouse
    shelter [c]
    shelters [c]
    hotline
    trafficking
    kidnap*
    hostage*
    ex husband
    ex wife
    ex boyfriend
    ex girlfriend
    ex partner
    ex spouse
    ex fiance
    exhusband
    exwife
    exboyfriend
    exgirlfriend
    expartner
    exspouse
    estranged
    gunshot*
    firearm*
    handgun*
    pistol*
    weapon*
    bullet*
    police
    policeman
    policemen
    policewoman
    cops
    sheriff*
    deputy
    deputies
    called 911
    call 911
    calling 911
    911 [c]
    violencia domestica
    violencia familiar
    maltrat*
    abuso
    abusos
    abusa
    abusan
    abusar
    abusad*
    orden de restriccion
    ordenes de restriccion
    orden de proteccion
    orden de alejamiento
    acoso
    acosad*
    acosar
    acosan
    amenaz*
    agredid*
    agres*
    victima*
    miedo
    temor
    teme por
    refugio [c]
    refugios [c]
    ex esposo
    ex marido
    ex esposa
    ex novio
    ex novia
    ex pareja
    expareja
    exesposo
    exesposa
    exmarido
    exnovio
    exnovia
    arma de fuego
    armas de fuego
    pistola*
    policia*
    alguacil*
    alguaciles
    violacion [c]
    violaciones [c]
    violador*
    secuestr*
    balacera*
    patrulla [c]
  `),

  // ─── 2. minors ───────────────────────────────────────────────────────────
  // Not bare: minor, menor (minor leak, fuga menor); equipment ages (12 year old water heater).
  minors: lines(`
    child*
    kid
    kids
    kiddo
    kiddos
    baby
    babies
    infant*
    toddler*
    newborn*
    minors
    underage
    under age
    teen
    teens
    teenager*
    teenage*
    teenaged
    boy
    boys
    girl
    girls
    son
    sons
    daughter*
    stepson*
    stepdaughter*
    stepchild*
    grandson*
    granddaughter*
    grandchild*
    grandkid*
    school [c]
    schools [c]
    preschool*
    kindergarten*
    daycare
    day care
    babysit*
    nanny
    nannies
    crib [c]
    cribs [c]
    playpen*
    bassinet*
    stroller [c]
    strollers [c]
    pediatric*
    juvenile*
    adopted
    adoption
    foster child*
    foster kid
    foster kids
    foster care
    orphan*
    custody
    nino
    ninos
    nina
    ninas
    ninez
    ninito*
    ninita*
    ninera*
    bebe [c]
    bebes [c]
    recien nacido
    recien nacida
    recien nacidos
    recien nacidas
    menor de edad
    menores de edad
    los menores
    hijo
    hija
    hijos
    hijas
    hijito*
    hijita*
    nieto
    nieta
    nietos
    nietas
    adolescente*
    escuela [c]
    escuelas [c]
    colegio [c]
    kinder [c]
    guarderia*
    preescolar*
    cuna [c]
    cunas [c]
    chamaco
    chamaca
    chamacos
    chamacas
  `),

  // ─── 3. health and disability ────────────────────────────────────────────
  health: lines(`
    sick
    sicker
    sickly
    sickness
    illness*
    disease*
    infection*
    infectious
    infected
    surgery
    surgeries
    surgical
    surgeon*
    hospital* [c]
    doctor*
    nurse*
    nursing [c]
    caregiver*
    care giver*
    home health
    health aide
    health aides
    aide
    aides
    hospice*
    oxygen
    ventilator [c]
    ventilators [c]
    dialysis
    chemo*
    insulin
    diabet*
    asthma*
    allerg*
    copd
    dementia
    alzheimer*
    parkinson*
    epilep*
    seizure*
    stroke [c]
    strokes [c]
    heart attack*
    heart condition*
    heart disease
    paraly*
    wheelchair*
    wheel chair
    wheel chairs
    walker [c]
    walkers [c]
    cane [c]
    canes [c]
    crutch*
    hospital bed
    hospital beds
    lift chair*
    stair lift
    stair lifts
    stairlift*
    grab bar [c]
    grab bars [c]
    medical*
    medication*
    medicine [c]
    medicines [c]
    meds
    pills
    prescription*
    therapy
    therapist*
    mental*
    psychiatr*
    psycholog*
    suicid*
    overdose*
    rehab* [c]
    sober*
    sobriety
    addict*
    alcoholic*
    alcoholism
    covid*
    coronavirus*
    quarantin*
    contagious
    pregnan*
    maternity
    miscarriage*
    his health
    her health
    their health
    poor health
    health issue*
    health problem*
    health condition*
    health concern*
    health [c]
    accessible [c]
    accessibility
    ada
    handicap*
    disabilit*
    disabled
    impair*
    blindness
    deafness
    hearing aid
    hearing aids
    hearing impaired
    visually impaired
    bedridden
    bedbound
    bed bound
    homebound
    home bound
    incontinen*
    catheter*
    cpap
    nebulizer*
    feeding tube
    feeding tubes
    inhaler*
    oxygen tank
    oxygen tanks
    autis*
    bipolar
    schizo*
    anxiety
    depress*
    trauma*
    cancer*
    tumor*
    leukemia
    hiv
    hoarding
    hoarder*
    mobility
    service animal*
    emotional support
    comfort animal*
    guide dog
    guide dogs
    enferm*
    salud
    medico
    medica
    medicos
    medicas
    medicina [c]
    medicinas [c]
    medicament*
    medicacion
    pastilla*
    insulina
    oxigeno
    dialisis
    quimio*
    asma
    silla de ruedas
    sillas de ruedas
    baston
    bastones
    muleta*
    discapacit*
    minusvalid*
    incapacitad*
    ciego
    ciega
    ciegos
    ciegas
    sordo
    sorda
    sordos
    sordas
    embaraz*
    gestante*
    parto
    clinica [c]
    cuidador*
    terapia*
    terapeuta*
    demencia
    derrame cerebral
    infarto*
    cirugia*
    depresion
    ansiedad
    adiccion
    adicto
    adicta
    adictos
    adictas
    rehabilitacion [c]
    contagi*
    andador [c]
  `),

  // ─── 4. immigration and language ─────────────────────────────────────────
  // Never bare "ice". Language words and nationality words are handled by
  // PAIR_RULES (they matter only next to "speaks"/"only" or a person noun).
  // Not bare: spanish (Spanish tile roof), mexican (Mexican tile), negro/blanco (colors), residencia.
  immigration_language: lines(`
    ice agent*
    ice officer*
    ice raid
    ice raids
    ice detain*
    ice arrest*
    called ice
    calling ice
    call ice
    immigra*
    undocumented
    deport*
    detain*
    detention
    border patrol
    visa [c]
    visas [c]
    passport*
    citizen*
    noncitizen*
    non citizen*
    refugee*
    asylum*
    daca
    dreamer*
    work permit [c]
    work permits [c]
    work authorization*
    green card
    green cards
    itin
    country of origin
    no english
    limited english
    little english
    broken english
    does not speak english
    doesn t speak english
    translator*
    interpreter*
    translat*
    bilingual*
    language barrier*
    foreigner*
    naturaliz*
    migrant*
    nationality
    inmigra*
    migra
    la migra
    indocumentad*
    sin papeles
    redada*
    patrulla fronteriza
    agentes de ice
    agente de ice
    pasaporte*
    permiso de trabajo
    tarjeta verde
    ciudadan*
    asilo [c]
    refugiado*
    refugiada*
    no habla ingles
    no entiende ingles
    solo habla espanol
    habla espanol
    habla chino
    habla coreano
    habla vietnamita
    habla armenio
    habla tagalog
    traductor*
    interprete*
    traduc*
    extranjero*
    extranjera*
    nacionalidad
    migrante*
  `),

  // ─── 5. religion and identity (slurs are SLURS below) ────────────────────
  religion_identity: lines(`
    pastor*
    priest*
    rabbi*
    imam
    imams
    sabbath
    shabbat
    shabbos
    kosher
    halal
    ramadan
    passover
    hanukkah
    chanukah
    yom kippur
    rosh hashanah
    prayer*
    pray
    prays
    prayed
    praying
    worship*
    bible*
    quran
    koran
    torah
    mezuzah*
    jesus
    allah
    god
    faith
    jehovah*
    mormon*
    lgbt
    lgbtq
    lgbtqia
    queer
    same sex
    samesex
    transsexual*
    transgender*
    transitioning
    pronoun*
    gender*
    nonbinary
    non binary
    homosexual*
    bisexual*
    heterosexual*
    sexuality
    churches [c]
    mosque*
    synagogue*
    chapel* [c]
    religio*
    christian*
    catholic*
    muslim*
    jews
    hindu*
    sikh
    sikhs
    sikhism
    buddh*
    atheis*
    islam*
    hijab*
    burka
    niqab
    turban*
    yarmulke*
    kippah
    sermon*
    iglesia*
    sacerdote*
    rabino*
    oracion
    oraciones
    orar
    biblia*
    dios
    catolic*
    cristian*
    evangelic*
    musulman*
    judio
    judia
    judios
    judias
    lesbian*
    gay
    gays
    transgenero
    transexual*
    orientacion sexual
    identidad de genero
    pareja del mismo sexo
    mismo sexo
    templo* [c]
    mezquita*
    sinagoga*
    testigos de jehova
  `),

  // ─── 6. benefits and income ──────────────────────────────────────────────
  benefits_income: lines(`
    voucher*
    hud
    housing authority
    housing choice
    hacla
    hacoc
    medi cal
    medicaid
    medicare
    ihss
    regional center*
    dpss
    ssdi
    sdi
    unemployment
    unemployed
    edd
    cash aid
    general relief
    wic
    calworks
    calfresh
    social worker*
    caseworker*
    case manager*
    rapid rehousing
    emergency rental assistance
    government assistance
    on assistance
    social security
    sec 8
    sect 8
    section eight
    subsid*
    low income
    fixed income
    no income
    limited income
    laid off
    seccion 8
    vale de vivienda
    vales de vivienda
    cupon de vivienda
    cupones de vivienda
    asistencia publica
    asistencia del gobierno
    asistencia social
    estampillas
    trabajador social
    trabajadora social
    seguro social
    desempleo
    desempleado*
    bajos ingresos
    ingresos fijos
    sin ingresos
  `),

  // ─── 7. legal and eviction ───────────────────────────────────────────────
  // Not bare: embargo (sin embargo), corte (corte de agua), courtyard.
  legal_eviction: lines(`
    evict*
    unlawful detainer
    3 day notice
    3 days notice
    three day notice
    5 day notice
    10 day notice
    15 day notice
    30 day notice
    thirty day notice
    60 day notice
    sixty day notice
    90 day notice
    ninety day notice
    notice to quit
    notice to vacate
    notice to pay
    notice of termination
    pay or quit
    cure or quit
    perform or quit
    lawsuit*
    sue
    sued
    sues
    suing
    lawyer*
    attorney*
    legal*
    illegal*
    court [c]
    courts [c]
    courthouse*
    courtroom*
    court date
    court dates
    court order*
    judge*
    hearing [c]
    hearings [c]
    subpoena*
    litigation
    lien
    liens
    collections
    bankruptcy
    foreclos*
    writ
    writs
    retaliat*
    habitability
    uninhabitable
    rent withholding
    withhold* rent
    withheld rent
    repair and deduct
    rent control
    just cause
    tenant union
    tenants union
    tenant s union
    tenants rights
    tenant rights
    tenant s rights
    demand letter*
    cease and desist
    small claims
    fair housing
    hud complaint*
    civil rights
    summons
    mediation
    arbitration
    legal action*
    desaloj*
    demanda*
    abogado*
    abogada*
    tribunal*
    juzgado*
    corte de justicia
    corte superior
    corte suprema
    juez
    jueza
    jueces
    aviso de 3 dias
    aviso de tres dias
    aviso de 30 dias
    aviso de 60 dias
    aviso de 90 dias
    aviso de desalojo
    orden judicial
    citacion
    audiencia*
    bancarrota
    represalia*
    inhabitable*
    derechos de inquilinos
    derechos del inquilino
    ilegal*
    embargad*
  `),

  // ─── 8. arrest and criminal record ───────────────────────────────────────
  // Not held: weed (landscaping).
  criminal_arrest: lines(`
    arrest*
    jail
    jails
    jailed
    prison*
    inmate*
    felon*
    misdemeanor*
    convict*
    criminal*
    crime*
    probation*
    parole*
    sex offender*
    megan s law
    megans law
    warrant [c]
    warrants [c]
    bail [c]
    booked [c]
    police report*
    drug
    drugs
    meth
    cocaine
    heroin
    fentanyl*
    narcotic*
    marijuana
    cannabis
    gang [c]
    gangs [c]
    gangster*
    theft
    thief
    stolen
    burglar*
    burglary
    robbery
    robbed
    incarcerat*
    arresto*
    arrestad*
    carcel*
    prision*
    preso [c]
    presa [c]
    presos [c]
    delito*
    antecedentes penales
    libertad condicional
    orden de arresto
    droga*
    pandilla*
    narcotico*
    mariguana
    marihuana
    cocaina
    heroina
    metanfetamina*
    ladron*
    robo
    robos
    robado*
    crimen
    crimenes
    cartel*
  `),

  // ─── 9. death ────────────────────────────────────────────────────────────
  // Not bare: died, dead, muerto (pump died, dead bolt, dead outlet). See PAIR_RULES.
  death: lines(`
    death*
    deceased
    passed away
    passed on
    has passed
    have passed
    funeral*
    obituary
    obituaries
    probate
    next of kin
    coroner*
    suicide*
    homicide*
    murder*
    killed
    found dead
    dead body
    dead bodies
    dead person
    late husband
    late wife
    late mother
    late father
    late mom
    late dad
    late tenant
    late owner
    bereave*
    cremat*
    burial*
    cemetery
    heirs
    heir
    muerte*
    murio
    murieron
    fallecio
    falleci*
    difunto*
    difunta*
    velorio*
    entierro*
    testamento*
    forense*
    asesinad*
    asesinato*
    encontrado muerto
    encontrada muerta
    encontrado sin vida
    sin vida
    cadaver*
    defuncion*
    luto
    finado
    finada
    herederos
  `),

  // ─── 10. financial identifiers (words and phrases; patterns are in the screen) ───
  // Not held: gate, lockbox, alarm and garage codes, pin, phone numbers, emails, unit numbers.
  financial_id: lines(`
    ssn
    social security number*
    routing number*
    account number*
    acct number*
    card number*
    credit card
    credit cards
    debit card
    debit cards
    bank account*
    bank routing
    cvv
    cvc
    password*
    passwd
    date of birth
    dob
    birth date
    birthdate
    drivers license*
    driver s license*
    driving license
    numero de seguro social
    numero de cuenta
    tarjeta de credito
    tarjeta de debito
    contrasena*
    fecha de nacimiento
    licencia de conducir
  `),
};

// ═══ wo-supp-v2 ADDITIONS ═════════════════════════════════════════════════
// Fix round of 2026-10-16 (governance conditions W6; TARS fix list; Viper
// findings 8). ADDING ONLY: nothing above is removed or loosened. Categories
// here may also be the shared Fair Housing keys, because these terms extend
// those categories (the screen records only the category NAME). Every entry
// still holds the whole block; [c] marks an everyday word, as in v1.
const TERMS_V2_ADDITIONS = {
  // A short domestic-violence and safety list, English and Spanish.
  safety_violence: lines(`
    dv
    dvro
    tro
    safe at home
    address confidentiality
    confidential address
    hits her
    hit her
    beats her
    beat her
    beaten
    hurt her
    hurts her
    bruise*
    her ex
    his ex
    their ex
    hiding from
    afraid
    scared
    trespass notice*
    officer
    officers
    lapd
    lasd
    law enforcement
    golpea*
    moretones
    su ex
    mi ex
    le pega
    domestic issue*
    advocate*
    feels unsafe
    feel unsafe
    not feel safe
    do not let him in
    do not let her in
    don t let him in
    don t let her in
  `),

  // Common abbreviations and plain forms for medical terms, emergency services.
  health: lines(`
    aids
    sida
    vih
    std
    stds
    hepatitis*
    tuberculosis
    ocd
    adl
    ems
    icu
    ambulance*
    ambulancia*
    paramedic*
    paramedico*
    emergency room
    emergency rooms
    clinic [c]
    clinics [c]
    self harm
    selfharm
  `),

  // Assistance-animal wording, English and Spanish (the shared list has the singular phrases only).
  disability_health: lines(`
    assistance animal*
    assistance dog
    assistance dogs
    support animal*
    support dog
    support dogs
    service dog
    service dogs
    therapy animal*
    therapy dog
    therapy dogs
    seeing eye
    animal de servicio
    animales de servicio
    animal de apoyo
    animales de apoyo
    animal de asistencia
    animales de asistencia
    perro de servicio
    perros de servicio
    perro guia
    perros guia
    perro de apoyo
    perros de apoyo
    mascota de apoyo
    mascota de servicio
    apoyo emocional
  `),

  // Abbreviations and plain forms for benefits; veterans.
  benefits_income: lines(`
    ebt
    tanf
    food assistance
    rental assistance
    housing assistance
    cash assistance
    general assistance
    section8
    sect8
    sec8
    s8
    s 8
    section viii
    sec viii
    foodstamps
    food stamp
    cupones de comida
    veteran*
  `),

  // Immigration abbreviations and plain forms, English and Spanish.
  immigration_language: lines(`
    uscis
    cbp
    tps
    resident alien
    foreign national*
    no papers
    sin documentos
    no tiene papeles
    no tienen papeles
    migracion
  `),

  // Plural forms of identity words the shared and v1 lists already hold in the singular.
  race_color: lines(`
    blacks
    whites
    asians
    hispanics
    hispanos
    hispanas
    latinos
    latinas
    caucasians
    africans
    african americans
    native americans
    pacific islanders
    middle easterners
    asiaticos
    asiaticas
    africanos
    africanas
  `),
  national_origin_immigration: lines(`
    arabs
    persians
    armenians
    koreans
    filipinos
    indians
    russians
    mexicans
    salvadorans
    guatemalans
    hondurans
    cubans
    colombians
    peruvians
    nicaraguans
    pakistanis
    iranians
    iraqis
    syrians
    afghans
    cambodians
    ethiopians
    nigerians
    somalis
    haitians
    jamaicans
    brazilians
    ukrainians
    mexicanos
    mexicanas
    salvadorenos
    salvadorenas
    guatemaltecos
    guatemaltecas
    hondurenos
    hondurenas
    colombianos
    colombianas
    peruanos
    peruanas
    cubanos
    cubanas
    coreanos
    coreanas
    vietnamitas
    filipinas
    arabes
    rusos
    rusas
  `),
  religion: lines(`
    jew
  `),
  religion_identity: lines(`
    queers
  `),
  sex_gender: lines(`
    woman
    women
    lady
    ladies
  `),
  marital_status: lines(`
    widows
    widowers
    widowed
    divorcee*
    spouses
    domestic partners
  `),
  age: lines(`
    old lady
    old man
    old woman
    retired
    retiree*
    senior citizens
  `),
  death: lines(`
    passed last
    passed yesterday
    passed recently
    recently passed
  `),
  criminal_arrest: lines(`
    dui
    dwi
  `),
  financial_id: lines(`
    driver license
    driver licence
    drivers licence
  `),
  legal_eviction: lines(`
    unlawful detainers
    notices to quit
    notices to vacate
  `),
};

// ═══ wo-supp-v3 ADDITIONS ═════════════════════════════════════════════════
// Third fix round of 2026-10-16 (Asimov R3-6, a bounded vocabulary round,
// ADDITIONS ONLY, a Standard change shown to Peter as a diff): Spanish for the
// vocabulary the English list already covers, direct first- and second-person
// statements of violence, stalking and fear, the person's own ex, and a few
// English words named by the testers. Nothing above is removed or loosened.
// Ordinary Spanish repair words (corte, mayor, menor, multa, rampa, mica,
// residencia, papeles on its own) are deliberately NOT held.
const TERMS_V3_ADDITIONS = {
  // Direct first- and second-person statements of violence, stalking, fear and fleeing, the person's own ex, and the Spanish equivalents of the English list.
  safety_violence: lines(`
    hit me
    hits me
    hit him
    hits him
    hitting me
    hitting her
    hitting him
    beat me
    beats me
    beat him
    beats him
    beating me
    beating her
    beating him
    hurt me
    hurts me
    hurt him
    hurts him
    hurting me
    hurting her
    hurting him
    punched me
    punched her
    punched him
    slapped me
    slapped her
    slapped him
    kicked me
    kicked her
    kicked him
    shoved me
    shoved her
    shoved him
    pushed me
    pushed her
    pushed him
    choked me
    choked her
    choked him
    strangl*
    grabbed me
    grabbed her
    follows me
    following me
    followed me
    being followed
    kill me
    kill you
    kill her
    kill him
    kill myself
    kill himself
    kill herself
    killing me
    my ex
    your ex
    the ex keeps
    the ex still
    the ex is
    the ex was
    the ex has
    the ex called
    the ex came
    the ex comes
    the ex shows
    the ex showed
    the ex wants
    the ex lives
    ex keeps
    ex still
    do not give him
    do not give her
    dont give him
    dont give her
    don t give him
    don t give her
    never give him
    never give her
    do not allow him
    do not allow her
    dont allow him
    dont allow her
    don t allow him
    don t allow her
    not allow him in
    not allow her in
    keep him out
    keep her out
    has a gun
    have a gun
    had a gun
    owns a gun
    pulled a gun
    pointed a gun
    fled
    fleeing
    me pega
    me pego
    me pegaba
    me pegan
    le pego
    le pegaba
    le pegan
    les pega
    nos pega
    golpeo
    golpee
    me acosa
    acosa
    acosaba
    acosando
    acosaron
    agred*
    asust*
    huyendo
    huye
    huyo
    huyeron
    huir
    huia
    escondiendose de
    escondida de
    escondido de
    me va a matar
    me quiere matar
    la va a matar
    la quiere matar
    lo va a matar
    lo quiere matar
    matarme
    matarla
    matarlo
    me empujo
    me empuja
    me persigue
    la persigue
    lo persigue
    no lo dejen entrar
    no la dejen entrar
    no lo dejes entrar
    no la dejes entrar
    no lo deje entrar
    no la deje entrar
    no le den llave
    no le den la llave
    no le den una llave
    no le des llave
    no le des la llave
    no le entreguen llave
    me siento insegura
    me siento inseguro
    no me siento segura
    no me siento seguro
    se siente insegura
    se siente inseguro
    no se siente segura
    no se siente seguro
    tu ex
  `),
  // Spanish affectionate forms for children, and grandparents.
  minors: lines(`
    mijo
    mija
    mijos
    mijas
    mijito
    mijita
    mijitos
    mijitas
    abuel*
    nena
    nenas
    nene
    nenes
    chiquill*
    chamaquito
    chamaquita
    bebito
    bebita
  `),
  // Single parent, English and Spanish.
  familial_status: lines(`
    single mother
    single mom
    single father
    single dad
    single parent*
    madre soltera
    padre soltero
    mama soltera
    papa soltero
  `),
  // Spanish disability, equipment, pregnancy and birth words; English birth and heart wording.
  health: lines(`
    discapacidad*
    minusvalia
    paralis*
    paralitic*
    artritis
    artrosis
    reumatismo
    arthritis
    protesis
    audifono*
    en tratamiento
    no puede caminar
    dificultad para caminar
    dificultad al caminar
    problemas para caminar
    encinta
    prenada
    dio a luz
    dar a luz
    da a luz
    dara a luz
    dieron a luz
    dando a luz
    gave birth
    give birth
    gives birth
    giving birth
    given birth
    bad heart
    weak heart
    heart problem*
    heart trouble
  `),
  // Assistance animals, Spanish.
  disability_health: lines(`
    perro de asistencia
    perros de asistencia
    perro lazarillo
    perros lazarillo
    perro de ayuda
    perros de ayuda
    soporte emocional
    animal de soporte
    animales de soporte
    mascota de asistencia
  `),
  // Widow and widower forms, divorce, Spanish.
  marital_status: lines(`
    viudo
    viuda
    viudos
    viudas
    viudez
    widowhood
    divorciad*
    divorcio
    divorcios
  `),
  // Old age, retirement and pensions, Spanish.
  age: lines(`
    ancian*
    tercera edad
    persona mayor
    personas mayores
    adulto mayor
    adultos mayores
    gente mayor
    senora mayor
    senor mayor
    viejito
    viejita
    viejitos
    viejitas
    jubilad*
    jubilacion
    jubilarse
    pensionad*
    pensionista*
    su pension
    la pension
    pension de
    pension del
    pension por
    pension alimenticia
    recibe pension
    tiene pension
    cobra pension
  `),
  // Public benefits and food programs, Spanish.
  benefits_income: lines(`
    cupones
    ayuda del gobierno
    ayuda de gobierno
    ayuda gubernamental
    ayuda publica
    ayuda del estado
    beneficios del gobierno
    beneficios publicos
    cupones de alimentos
    recibe cupones
    tiene cupones
    seguro de discapacidad
    seguro por discapacidad
    ayuda con la renta
    ayuda para la renta
    ayuda de renta
    asistencia con la renta
    asistencia de renta
    asistencia para la renta
    asistencia de vivienda
    asistencia para vivienda
    programa de vivienda
  `),
  // Immigration papers and residence, Spanish.
  immigration_language: lines(`
    residencia permanente
    residente permanente
    residentes permanentes
    tarjeta de residente
    tarjeta de residencia
    permiso de residencia
    papeles migratorios
    arreglar papeles
    arreglando papeles
    arreglo de papeles
    no tiene documentos
    no tienen documentos
    documentos migratorios
    migratori*
    consulado*
  `),
  // Rent arrears, English and Spanish.
  legal_eviction: lines(`
    behind on rent
    behind on the rent
    behind in rent
    late on rent
    late on the rent
    owes rent
    owes back rent
    back rent
    past due rent
    rent arrears
    atrasada con la renta
    atrasado con la renta
    atrasada con el alquiler
    atrasado con el alquiler
    atrasada en la renta
    atrasado en la renta
    atrasados con la renta
    debe renta
    debe la renta
    debe el alquiler
    renta atrasada
    renta vencida
    renta adeudada
    no ha pagado la renta
    no pago la renta
    no paga la renta
    no paga renta
  `),
  // Nun / monja.
  religion_identity: lines(`
    nun
    nuns
    monja*
  `),
  // Police reports and complaints, Spanish.
  criminal_arrest: lines(`
    denunci*
  `),
};

// ═══ wo-supp-v4 ADDITIONS ═════════════════════════════════════════════════
// Fourth fix round of 2026-10-16 (Asimov R4-4, Viper R3/R4/R5; ADDITIONS ONLY, a
// Standard change shown to Peter as a diff). Nothing above is removed or loosened.
// Only what the red-team round marked as a real gap and cheap: words for violence
// done to a person (molested, touched me, spanking, the injuries that follow
// a beating), the Section 8 program's own jargon, and the first-person Spanish
// forms of phrases already held in the third person ("no tengo papeles").
// Violence verbs followed by a person (hits his wife, beats my mother) are the
// pair rules PAIR_RULES_V4_ADDITIONS below, not words.
const TERMS_V4_ADDITIONS = {
  safety_violence: lines(`
    molested
    molester
    molesters
    molesting
    molests
    molestation
    touched me
    touches me
    touching me
    spank
    spanks
    spanked
    spanking
    broken nose
    busted lip
    split lip
    fat lip
    broke her arm
    broke his arm
    broke my arm
    broke her leg
    broke his leg
    broke my leg
    broke her nose
    broke his nose
    broke my nose
    broke her jaw
    broke his jaw
    broke my jaw
    broke her ribs
    broke his ribs
    broke my ribs
    injured by him
    injured by her
    hurt by him
    hurt by her
    attacked by him
    attacked by her
  `),
  // First-person Spanish forms of what "no tiene papeles / documentos" already holds.
  immigration_language: lines(`
    no tengo papeles
    no tengo documentos
    no tenemos papeles
    no tenemos documentos
  `),
  // Section 8 under the program's own names (no ordinary repair use of any of them).
  source_of_income: lines(`
    hqs
    hap contract
    hap contracts
    hap payment
    hap payments
    pha inspection
    pha inspections
    ehv
    lihtc
    assisted housing
    tax credit unit
    family self sufficiency
    fss program
    va benefits
  `),
};

function mergeTerms(base, extra) {
  const out = {};
  for (const [cat, entries] of Object.entries(base)) out[cat] = entries.slice();
  for (const [cat, entries] of Object.entries(extra)) out[cat] = (out[cat] || []).concat(entries);
  return out;
}

const TERMS = mergeTerms(mergeTerms(mergeTerms(TERMS_V1, TERMS_V2_ADDITIONS), TERMS_V3_ADDITIONS), TERMS_V4_ADDITIONS);

// Meaning-bearing symbols (condition W6: "a short list"). Any ONE of these
// anywhere in the text holds the block under the category named. Everything
// else that is an emoji or a symbol passes (accepted residual risk). Code
// points, not characters, so the list can be read without a font.
const SYMBOLS = [
  { cat: 'disability_health', cps: [0x267F, 0x1F9BD, 0x1F9BC, 0x1F9AF, 0x1FA7C, 0x1F9CF, 0x1F9BB, 0x1F48A, 0x1FA7A, 0x1F489, 0x1FA78, 0x1F3E5, 0x1F691] },
  { cat: 'sex_gender', cps: [0x1F930, 0x1F931, 0x26A7, 0x1F3F3] },
  { cat: 'religion', cps: [0x1F54C, 0x1F54D, 0x271D, 0x2626, 0x262A, 0x2721, 0x1F54E, 0x2638, 0x1F6D0, 0x26EA, 0x1F549, 0x1F4FF] },
  { cat: 'race_color', ranges: [[0x1F3FB, 0x1F3FF]] },                    // skin-tone modifiers
  { cat: 'national_origin_immigration', ranges: [[0x1F1E6, 0x1F1FF]] },    // regional indicators (country flags)
  { cat: 'minors', cps: [0x1F476, 0x1F466, 0x1F467, 0x1F9D2, 0x1F37C, 0x1F46A] },
  { cat: 'safety_violence', cps: [0x1F693, 0x1F694, 0x1F46E, 0x1F52B] },
  { cat: 'death', cps: [0x26B0, 0x26B1, 0x1FAA6] },
  { cat: 'legal_eviction', cps: [0x2696] },
  { cat: 'unscreenable_language', ranges: [[0x1F150, 0x1F189]] },           // negative circled and squared letters (lettering look-alikes)
  // wo-supp-v3 (additions only): the remaining unambiguous pictographs of kinds already on the list.
  // Medical symbol and guide dog; pregnant person and pregnant man; older man, older woman, older adult;
  // Kaaba, Hindu temple, Shinto shrine and khanda (houses of worship and faith symbols).
  { cat: 'disability_health', cps: [0x2695, 0x1F9AE] },
  { cat: 'sex_gender', cps: [0x1FAC4, 0x1FAC3] },
  { cat: 'age', cps: [0x1F474, 0x1F475, 0x1F9D3] },
  { cat: 'religion', cps: [0x1F54B, 0x1F6D5, 0x26E9, 0x1FAAF] },
];

// Long two-word protected phrases that are also looked for with every
// separator removed (round 3, Asimov R3-2): typed as one word, or glued by
// invisible characters inside and between the words. Each is a phrase that is
// really on the shared list or the lists above, has exactly two words and at
// least nine letters in all (the screen checks all three at load time). This is
// NOT substring matching of the whole list: only these, and only because they
// are long enough that they do not occur inside ordinary words.
const SQUASHED_PHRASES = [
  { phrase: 'restraining order', cat: 'safety_violence' },
  { phrase: 'domestic violence', cat: 'safety_violence' },
  { phrase: 'domestic abuse', cat: 'safety_violence' },
  { phrase: 'protective order', cat: 'safety_violence' },
  { phrase: 'protection order', cat: 'safety_violence' },
  { phrase: 'unlawful detainer', cat: 'legal_eviction' },
  { phrase: 'green card', cat: 'national_origin_immigration' },
  { phrase: 'border patrol', cat: 'immigration_language' },
  { phrase: 'sex offender', cat: 'criminal_arrest' },
  { phrase: 'police report', cat: 'criminal_arrest' },
  { phrase: 'passed away', cat: 'death' },
  { phrase: 'food stamps', cat: 'source_of_income' },
  { phrase: 'housing voucher', cat: 'source_of_income' },
  { phrase: 'public assistance', cat: 'source_of_income' },
  { phrase: 'mental health', cat: 'disability_health' },
  { phrase: 'mental illness', cat: 'disability_health' },
  { phrase: 'service animal', cat: 'disability_health' },
  { phrase: 'assistance animal', cat: 'disability_health' },
  { phrase: 'emotional support', cat: 'health' },
  { phrase: 'reasonable accommodation', cat: 'disability_health' },
  { phrase: 'immigration status', cat: 'national_origin_immigration' },
  { phrase: 'national origin', cat: 'national_origin_immigration' },
  { phrase: 'gender identity', cat: 'sex_gender' },
  { phrase: 'sexual orientation', cat: 'sex_gender' },
  { phrase: 'marital status', cat: 'marital_status' },
  { phrase: 'domestic partner', cat: 'marital_status' },
  { phrase: 'familial status', cat: 'familial_status' },
  { phrase: 'senior citizen', cat: 'age' },
  { phrase: 'african american', cat: 'race_color' },
  { phrase: 'native american', cat: 'race_color' },
  { phrase: 'pacific islander', cat: 'race_color' },
  { phrase: 'middle eastern', cat: 'race_color' },
  { phrase: 'skin color', cat: 'race_color' },
];

// Terms of PAIR_RULES: a word from `a` and a word from `b` within `window`
// word positions of each other. order 'any' = either way round;
// 'a_before_b' = an `a` word must come before the `b` word.
const LANGUAGE_WORDS = [
  'spanish', 'mandarin', 'cantonese', 'chinese', 'korean', 'vietnamese', 'tagalog', 'filipino',
  'armenian', 'farsi', 'persian', 'arabic', 'russian', 'hindi', 'punjabi', 'japanese', 'thai',
  'hmong', 'portuguese', 'french', 'english',
  'espanol', 'ingles', 'chino', 'coreano', 'vietnamita', 'armenio', 'arabe', 'ruso', 'frances',
  'japones', 'portugues', 'aleman', 'mandarin', 'cantones',
];

const PERSON_NOUNS_EN = [
  'man', 'men', 'woman', 'women', 'lady', 'ladies', 'guy', 'guys', 'family', 'families', 'couple',
  'tenant', 'tenants', 'people', 'kids', 'neighbor', 'neighbors', 'neighbour', 'neighbours',
  'resident', 'residents', 'boy', 'girl', 'gentleman', 'person', 'persons', 'gentlemen',
];

const PERSON_NOUNS_ES = [
  'hombre', 'hombres', 'mujer', 'mujeres', 'senor', 'senores', 'senora', 'senoras', 'familia',
  'familias', 'pareja', 'inquilino', 'inquilina', 'inquilinos', 'inquilinas', 'vecino', 'vecina',
  'vecinos', 'vecinas', 'gente', 'muchacho', 'muchacha', 'muchachos', 'muchachas',
];

const NATIONALITY_OR_COLOR_EN = [
  'mexican', 'salvadoran', 'guatemalan', 'honduran', 'asian', 'african', 'arab', 'persian',
  'armenian', 'korean', 'chinese', 'vietnamese', 'filipino', 'indian', 'russian', 'black', 'white',
  'latino', 'latina', 'hispanic', 'japanese', 'cuban', 'colombian', 'peruvian', 'nicaraguan',
  'pakistani', 'iranian', 'iraqi', 'syrian', 'afghan', 'thai', 'hmong', 'cambodian', 'ethiopian',
  'nigerian', 'somali', 'haitian', 'jamaican', 'brazilian', 'polish', 'ukrainian',
];

const NATIONALITY_OR_COLOR_ES = [
  'negro', 'negra', 'negros', 'negras', 'blanco', 'blanca', 'blancos', 'blancas', 'moreno',
  'morena', 'morenos', 'morenas', 'mexicano', 'mexicana', 'mexicanos', 'mexicanas', 'salvadoreno',
  'salvadorena', 'guatemalteco', 'guatemalteca', 'hondureno', 'asiatico', 'asiatica',
  'africano', 'africana', 'arabe', 'coreano', 'coreana', 'chino', 'china', 'chinos', 'vietnamita',
  'filipino', 'filipina', 'indio', 'india', 'ruso', 'rusa', 'armenio', 'armenia', 'persa',
  'cubano', 'cubana', 'colombiano', 'colombiana', 'peruano', 'peruana', 'hondurena',
];

const PERSON_WORDS_BEFORE_DIED = [
  'tenant', 'tenants', 'resident', 'residents', 'owner', 'owners', 'occupant', 'occupants',
  'husband', 'wife', 'mother', 'father', 'mom', 'dad', 'he', 'she', 'man', 'woman', 'lady',
  'neighbor', 'neighbour', 'grandmother', 'grandfather', 'grandma', 'grandpa', 'son', 'daughter',
  'brother', 'sister', 'uncle', 'aunt', 'roommate', 'partner', 'spouse', 'gentleman',
  'inquilino', 'inquilina', 'senor', 'senora', 'esposo', 'esposa', 'madre', 'padre', 'hombre',
  'mujer', 'vecino', 'vecina', 'dueno', 'duena', 'abuelo', 'abuela', 'hermano', 'hermana', 'ella',
];

const PAIR_RULES_V1 = [
  { cat: 'immigration_language', name: 'speaks-language',
    a: ['speak', 'speaks', 'speaking', 'spoke', 'spoken'], b: LANGUAGE_WORDS, window: 4, order: 'any' },
  { cat: 'immigration_language', name: 'language-only',
    a: LANGUAGE_WORDS, b: ['only', 'speaking', 'speaker', 'speakers', 'language'], window: 4, order: 'any' },
  { cat: 'immigration_language', name: 'habla-language',
    a: ['habla', 'hablan', 'hablar', 'hablo', 'hablaba', 'hablamos', 'solo', 'solamente', 'unicamente'],
    b: LANGUAGE_WORDS, window: 4, order: 'any' },
  { cat: 'immigration_language', name: 'nationality-person-en',
    a: NATIONALITY_OR_COLOR_EN, b: PERSON_NOUNS_EN, window: 4, order: 'any' },
  { cat: 'immigration_language', name: 'nationality-person-es',
    a: NATIONALITY_OR_COLOR_ES, b: PERSON_NOUNS_ES, window: 4, order: 'any' },
  { cat: 'death', name: 'person-died',
    a: PERSON_WORDS_BEFORE_DIED, b: ['died', 'dies', 'dead', 'dying'], window: 4, order: 'a_before_b' },
  { cat: 'death', name: 'persona-muerto',
    a: PERSON_WORDS_BEFORE_DIED, b: ['muerto', 'muerta', 'muertos', 'muertas'], window: 4, order: 'a_before_b' },
  { cat: 'health', name: 'is-ill',
    a: ['is', 'was', 'been', 'very', 'being', 'become', 'became', 'getting', 'feeling', 'feels', 'felt', 'tenant', 'she', 'he', 'resident'],
    b: ['ill'], window: 3, order: 'a_before_b' },
  { cat: 'health', name: 'mobility-scooter',
    a: ['scooter', 'scooters'], b: ['mobility', 'tenant', 'tenants', 'resident', 'electric', 'motorized', 'handicap', 'handicapped', 'disabled'],
    window: 4, order: 'any' },
];

// wo-supp-v2 pair rules (additions only).
// A country name right after "from", "born" or "native" (national origin), the
// words male / female next to a person noun (not "male adapter"), and a person
// word right before "passed" (death).
const COUNTRIES = [
  'mexico', 'guatemala', 'salvador', 'honduras', 'nicaragua', 'cuba', 'colombia', 'peru', 'venezuela', 'ecuador',
  'brazil', 'argentina', 'chile', 'bolivia', 'china', 'taiwan', 'korea', 'vietnam', 'philippines', 'india',
  'pakistan', 'iran', 'iraq', 'syria', 'lebanon', 'israel', 'armenia', 'russia', 'ukraine', 'poland',
  'ethiopia', 'nigeria', 'somalia', 'haiti', 'jamaica', 'afghanistan', 'thailand', 'cambodia', 'laos', 'japan',
  'indonesia', 'egypt', 'turkey', 'yemen', 'eritrea', 'sudan', 'ghana', 'kenya', 'jordan', 'palestine',
  'germany', 'france', 'italy', 'england', 'ireland', 'canada',
];
const PAIR_RULES_V2_ADDITIONS = [
  { cat: 'national_origin_immigration', name: 'from-country',
    a: ['from', 'born', 'native', 'natives'], b: COUNTRIES, window: 3, order: 'a_before_b' },
  { cat: 'sex_gender', name: 'sex-person',
    a: ['male', 'female', 'males', 'females'], b: PERSON_NOUNS_EN, window: 3, order: 'any' },
  { cat: 'death', name: 'person-passed',
    a: PERSON_WORDS_BEFORE_DIED, b: ['passed'], window: 2, order: 'a_before_b' },
];
// wo-supp-v3 pair rule (additions only): the Spanish "from" plus a country
// ("es de Mexico", "vino de Guatemala", "nacio en Peru"). Country names that are
// also ordinary Spanish words (chile = chili, china = porcelain, cuba = barrel)
// are left out; "El Salvador" is covered by its second word.
const COUNTRIES_ES = [
  'mexico', 'guatemala', 'salvador', 'honduras', 'nicaragua', 'colombia', 'peru', 'venezuela', 'ecuador',
  'brasil', 'argentina', 'bolivia', 'taiwan', 'corea', 'vietnam', 'filipinas', 'india', 'pakistan', 'iran', 'irak',
  'siria', 'libano', 'israel', 'armenia', 'rusia', 'ucrania', 'polonia', 'etiopia', 'nigeria', 'somalia', 'haiti',
  'jamaica', 'afganistan', 'tailandia', 'camboya', 'laos', 'japon', 'indonesia', 'egipto', 'yemen', 'eritrea',
  'sudan', 'ghana', 'kenia', 'palestina', 'alemania', 'francia', 'italia', 'inglaterra', 'irlanda', 'canada',
  'espana', 'portugal', 'turquia', 'costa', 'panama', 'paraguay', 'uruguay', 'republica',
];
const PAIR_RULES_V3_ADDITIONS = [
  { cat: 'national_origin_immigration', name: 'de-pais-es',
    a: ['es', 'son', 'era', 'eran', 'somos', 'viene', 'vienen', 'vino', 'vinieron', 'llego', 'llegaron', 'nacio', 'nacida', 'nacido', 'nacidos',
      'originario', 'originaria', 'oriundo', 'oriunda', 'natural', 'naturales', 'procedente', 'procedentes'],
    b: COUNTRIES_ES, window: 3, order: 'a_before_b' },
];
// wo-supp-v4 pair rules (additions only).
// (1) Violence done to a person who is named by a relationship ("he hits his wife",
// "my dad beats my mom"): a violence verb, then a relative, a partner or a child
// within three words after it. The verbs and the nouns are listed in full; neither
// side holds on its own. "He punched a hole in the wall" and "kicked in the door"
// have no such noun and pass.
// (2) The same in Spanish ("le pega a su esposa").
// (3) The first-person Spanish forms of the v3 "from" plus a country rule ("soy de
// Mexico", "naci en Honduras", "vengo de El Salvador").
const VIOLENCE_VERBS_EN = [
  'hit', 'hits', 'hitting', 'beat', 'beats', 'beating', 'slap', 'slaps', 'slapped', 'slapping',
  'punch', 'punches', 'punched', 'punching', 'choke', 'chokes', 'choked', 'choking',
  'kick', 'kicks', 'kicked', 'kicking', 'shove', 'shoves', 'shoved', 'shoving',
  'hurt', 'hurts', 'hurting', 'stab', 'stabs', 'stabbed', 'stabbing', 'smacked', 'smacks',
  'attacked', 'attacking',
];
// Not included on purpose: baby (baby gate, baby monitor), and the verbs push, grab and attack
// (grab bar, push button, heart attack are ordinary repair and household words).
const RELATIVE_PERSON_NOUNS_EN = [
  'wife', 'husband', 'girlfriend', 'boyfriend', 'partner', 'spouse', 'fiancee', 'fiance',
  'mom', 'mother', 'mum', 'mama', 'dad', 'father', 'papa', 'son', 'daughter', 'sister', 'brother',
  'grandmother', 'grandma', 'grandfather', 'grandpa', 'child', 'children', 'toddler', 'infant',
  'niece', 'nephew', 'aunt', 'uncle', 'stepson', 'stepdaughter', 'stepmother', 'stepfather',
];
// Not included on purpose: mata (a shrub), lastima (a pity), ataca (insects), agarra, and the golpea
// forms (the v2 stem golpea* already holds them).
const VIOLENCE_VERBS_ES = [
  'pega', 'pegaba', 'pego', 'pegan', 'pegaron', 'pegando',
  'abofetea', 'abofeteo', 'patea', 'pateo', 'patean', 'empuja', 'empujo', 'empujan', 'empujaron',
  'ahorca', 'ahorco', 'estrangula', 'hirio', 'hiere', 'apunala', 'apunalo',
];
const RELATIVE_PERSON_NOUNS_ES = [
  'esposa', 'esposo', 'mujer', 'marido', 'novia', 'novio', 'pareja', 'madre', 'mama', 'padre', 'papa', 'hijo', 'hija',
  'hijos', 'hijas', 'nino', 'nina', 'ninos', 'ninas', 'bebe', 'abuela', 'abuelo', 'hermana', 'hermano', 'suegra', 'suegro',
  'sobrina', 'sobrino', 'tia', 'tio', 'senora',
];
const PAIR_RULES_V4_ADDITIONS = [
  { cat: 'safety_violence', name: 'violence-person-en',
    a: VIOLENCE_VERBS_EN, b: RELATIVE_PERSON_NOUNS_EN, window: 3, order: 'a_before_b' },
  { cat: 'safety_violence', name: 'violence-person-es',
    a: VIOLENCE_VERBS_ES, b: RELATIVE_PERSON_NOUNS_ES, window: 3, order: 'a_before_b' },
  { cat: 'national_origin_immigration', name: 'de-pais-es-first-person',
    a: ['soy', 'eres', 'naci', 'nacimos', 'nacieron', 'vengo', 'venimos', 'vine', 'vinimos', 'viniste', 'vienes'],
    b: COUNTRIES_ES, window: 3, order: 'a_before_b' },
];
const PAIR_RULES = PAIR_RULES_V1.concat(PAIR_RULES_V2_ADDITIONS, PAIR_RULES_V3_ADDITIONS, PAIR_RULES_V4_ADDITIONS);

// Racial, ethnic, religious and sexual-orientation slurs, English and Spanish.
// Whole words only, matched after a light obfuscation fold (see the screen).
// Natural spelling here; the screen folds these the same way as the text.
const SLURS = [
  'nigger', 'niggers', 'nigga', 'niggas', 'spic', 'spics', 'spick', 'wetback', 'wetbacks',
  'beaner', 'beaners', 'chink', 'chinks', 'gook', 'gooks', 'jap', 'japs', 'kike', 'kikes',
  'coon', 'coons', 'darkie', 'darky', 'redskin', 'redskins', 'squaw', 'paki', 'pakis',
  'raghead', 'ragheads', 'towelhead', 'towelheads', 'honky', 'honkey', 'gringo', 'gringos',
  'greaser', 'greasers', 'wop', 'wops', 'dago', 'dagos', 'kraut', 'krauts', 'chinaman',
  'gypsy', 'gypsies', 'heeb', 'heebs', 'hymie',
  'faggot', 'faggots', 'fag', 'fags', 'dyke', 'dykes', 'homo', 'homos', 'tranny', 'trannies',
  'shemale', 'lesbo', 'lesbos', 'retard', 'retarded', 'retards', 'cripple', 'crippled',
  'maricon', 'maricones', 'marica', 'joto', 'jotos', 'negrata', 'sudaca', 'machorra',
  'tortillera', 'mariposon', 'puto', 'putos', 'marimacha',
];

// ~170 very common English and Spanish function and repair words, folded.
// Used ONLY by the "unrecognised language" check: text of 8 or more words in
// which fewer than 15 percent are on this list is held (it is probably in a
// language the keyword lists cannot read, such as Tagalog or Vietnamese).
const COMMON_WORDS = new Set((`
  the a an and or of to in on at is are was were be been it its this that these those with for from by
  not no yes has have had will would can could should may please need needs needed also but if when
  then there here as so than too very all any some each both more most other new old out up down off
  over under again once only just still about after before into onto per via
  tenant tenants resident owner unit apartment house home property building kitchen bathroom bedroom
  living room garage yard door doors window windows lock locks key keys light lights bulb bulbs fan
  heater heat heating cooling air ac hvac furnace thermostat water hot cold leak leaks leaking leaky
  sink faucet toilet shower tub drain drains clog clogged clogs pipe pipes valve pressure gas electric
  electrical power outlet outlets switch breaker panel wiring wire smoke detector alarm battery
  fridge refrigerator stove oven dishwasher disposal microwave washer dryer vent filter roof ceiling
  wall walls floor floors carpet tile paint painting stain mold fence gate sprinkler sprinklers lawn
  tree trees plumber electrician vendor contractor repair repairs replace replaced fix fixed broken
  damaged damage stuck loose noise noisy smell odor call called schedule scheduled access entry
  enter work order estimate approved approve cost quote inspection inspect check checked install
  installed remove removed clean cleaning pest mouse mice rodent ants roaches bees
  el la los las un una unos unas de del en y o que por para con sin no se es esta esto estan son
  hay como mas muy pero tambien cuando donde si su sus mi al lo le
  agua fuga fugas goteo gotea goteando puerta puertas ventana ventanas cerradura llave luz luces
  calentador aire acondicionado cocina bano bano inodoro lavabo regadera tubo tuberia drenaje
  tapado tapada roto rota roturas arreglar reparar reparacion cambiar techo pared piso pintura
  refrigerador estufa lavadora secadora electricidad enchufe apagador casa departamento inquilino
  favor necesita ruido olor
`).split(/\s+/).filter(Boolean));

module.exports = {
  WO_SUPP_VERSION,
  SHARED_CATEGORY_KEYS,
  FEATURE_CATEGORY_KEYS,
  CATEGORY_VOCABULARY,
  SHARED_COMMON_TERMS,
  TERMS,
  TERMS_V2_ADDITIONS,
  TERMS_V3_ADDITIONS,
  TERMS_V4_ADDITIONS,
  PAIR_RULES,
  PAIR_RULES_V2_ADDITIONS,
  PAIR_RULES_V3_ADDITIONS,
  PAIR_RULES_V4_ADDITIONS,
  SYMBOLS,
  SQUASHED_PHRASES,
  SLURS,
  COMMON_WORDS,
  LANGUAGE_WORDS,
};
