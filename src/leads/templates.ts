/**
 * Pre-baked operator-curated message templates the bot sends at lead
 * pipeline state transitions. These were dictated verbatim by the
 * operator and are kept here as plain string constants so the operator
 * can iterate on wording without touching any logic.
 *
 * Each template is sent as a separate Telegram message — not because of
 * length limits but because chunking makes it easier for the candidate
 * to scan and reply ("отправлю одним сообщением" instructions get lost
 * if buried in a 1500-char wall).
 */

/**
 * Sent to a new candidate to kick off intake. Lists the 7 items the
 * operator wants up front, before deciding whether to approve the lead.
 */
export const INTAKE_TEMPLATE = `Замечательно, а теперь приступим к заполнению анкеты!

Заполните анкету:
1. Имя и фамилия (как в паспорте)
2. Возраст
3. Рост
4. Вес
5. Гражданство
6. Семейное положение (не замужем / замужем)
7. Дети (нет / есть, укажите сколько)
8. Языки и уровень (например: английский B2, базовый китайский)
9. Опыт работы за последние 2 года (кратко)
10. Дата окончания загранпаспорта (дд.мм.гггг)
11. В каком городе вы сейчас и когда готовы выезжать
12. Фотографии 6-8 обычных (в полный рост 2-3)
13. 2 любых видео
14. Фото загран паспорта
15. Видео танца на 1 минуту (главное весёлая музыка и активные импровизированные движения)

Просьба заполнить и отправить одним сообщением, спасибо 🙌🌞`;

/**
 * Two-message preamble sent right after operator approves the lead.
 * Sent BEFORE the long English visa anketa so the candidate has the
 * context for what's coming.
 */
export const APPROVAL_PROLOGUE = `Замечательно! Вас одобрили в клубе. Сейчас приступим к подаче на рабочую визу.

У нас контракт, делается под каждую девушку, сейчас отправлю вам анкету, заполните её пожалуйста.`;

export const CONTRACT_TERMS = `Контракт отправлю в течение суток после подачи на рабочие документы. Также предупреждаем, что документы платные, но агентство уже покрыло за них денежные средства, так как вы едете на контракт минимум от 3 месяцев. Но если вы по своим причинам не сможете поехать, вам придётся возместить нам 1500 юаней.`;

/**
 * The full English-language visa application form. The candidate is
 * expected to fill the fields in-line and send back. Each line is a
 * field with a short Russian hint where useful.
 */
export const VISA_ANKETA_TEMPLATE = `АНКЕТА (заполнять на английском, как в паспорте)

Family name -
Given name -
Date of birth (yyyy-MM-dd) -
Country / Region (страна рождения) -
Province / State -
City (город рождения) -
Marital status (single / married) -
Current nationality -
National ID number (номер внутреннего паспорта) -
Do you have any other nationality(ies)? -
Do you have permanent residence of any other country or region? -
Have you ever held any other nationality(ies)? -
Passport / travel document number (номер загранпаспорта) -
Issuing country or region (страна, где выдали загранпаспорт) -
Issuing place (место, где выдали загранпаспорт — обычно цифры в паспорте) -
Expiration date (yyyy-MM-dd) (дата окончания загранпаспорта) -

Ваша работа за последние года (лучше указывать в вашей стране, можно неофициальную)
Work experience (list in reverse chronological order):
yyyy-MM-dd Still yyyy-MM-dd:
Name of employer:
Address of employer:
Telephone number:
Position:
Name of supervisor:
Phone number:

Обучение
Name of institution:
Diploma:
Major:

Current residence address (ваше место жительства) -
Phone number -
Mobile phone number -
Email address -

Family members
Father:
  Name -
  Nationality -
  Date of birth -

Mother:
  Name -
  Nationality -
  Date of birth -

Have you been to China? Yes / No -
Have you ever been issued a Chinese visa? -
  Type of visa -
  Number of visa -
  Place of issuance -
  Date of issuance -

Have you travelled to any other countries in the past 12 months -

Если были китайские визы — приложите фото виз.
Если есть дети или муж — укажите их данные (имя, фамилия, дата рождения, гражданство).
Если были замужем — также укажите.`;

export const VISA_PHOTO_REQUIREMENTS = `Фотография

От вас нужна электронная фотография (паспортного формата) и заполненная анкета. Если фотографии нет — сделайте, и сразу напечатайте 4 штуки 3,5×4,5 см: они также понадобятся при подаче.

И ещё — заполненные страницы загранпаспорта (если нет печатей, тогда фото двух пустых страниц).`;

/**
 * Polite default rejection. The operator can override per-lead via the
 * admin UI (rejected_reason field) — when provided, that message is
 * sent instead. Defaults err on the side of brief and human.
 */
export const REJECTION_DEFAULT = `Спасибо за интерес! К сожалению, сейчас не можем взять вас в работу. Если ситуация изменится — напишу.`;

/**
 * After visa docs are fully collected and the bot has posted to the
 * VISA_CHAT_ID for operator submission, the candidate gets this so
 * they're not left wondering.
 */
export const DOCS_COMPLETE_REPLY = `Спасибо, всё получили! Передаём документы в работу. Как только подадим на визу — напишу с номером заявки.`;

/**
 * The waiting-on-approval message — sent right after intake_complete
 * (lead card posted to ops chat, operator hasn't decided yet).
 */
export const AWAITING_APPROVAL_REPLY = `Спасибо, всё получили! Сейчас отправила запрос в клуб по вам, ждите ответа. Обычно в течение дня сообщаю.`;

/**
 * Initial intake field schema. Used by the auto-extractor (Phase 2) and
 * the lead card formatter — kept here so the operator's seven-item list
 * is one source of truth.
 */
export interface IntakeFields {
  age?: string;
  height?: string;
  weight?: string;
  city?: string;
  departure_readiness?: string;
  photos_count?: number;
  videos_count?: number;
  passport_photo_received?: boolean;
  dance_video_received?: boolean;
  name?: string;
  nationality?: string;
  marital_status?: string;
  children?: string;
  languages?: string;
  passport_expiry?: string;
  work_experience?: string;
}

export const INTAKE_FIELD_LABELS: Record<keyof IntakeFields, string> = {
  age: "возраст",
  height: "рост",
  weight: "вес",
  city: "город сейчас",
  departure_readiness: "готовность к выезду",
  photos_count: "фото 6-8 шт",
  videos_count: "2 видео",
  passport_photo_received: "фото загранпаспорта",
  dance_video_received: "видео танца",
  name: "имя",
  nationality: "гражданство",
  marital_status: "семейное положение",
  children: "дети",
  languages: "языки",
  passport_expiry: "загранпаспорт до",
  work_experience: "опыт работы",
};

export function isIntakeComplete(fields: IntakeFields | undefined): boolean {
  if (!fields) return false;
  return (
    !!fields.height &&
    !!fields.weight &&
    !!fields.city &&
    !!fields.departure_readiness &&
    (fields.photos_count ?? 0) >= 6 &&
    (fields.videos_count ?? 0) >= 2 &&
    fields.passport_photo_received === true &&
    fields.dance_video_received === true
  );
}
