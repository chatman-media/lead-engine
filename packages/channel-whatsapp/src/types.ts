// Минимальный набор WhatsApp Cloud API payload-типов которыми мы пользуемся.
// Полная спецификация:
//   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples

export interface WaMediaRef {
  id: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
}

export interface WaText {
  body: string;
}

export interface WaContext {
  from?: string;
  id: string;
}

export interface WaMessage {
  from: string;
  id: string;
  timestamp: string;
  type: "text" | "image" | "video" | "audio" | "voice" | "document" | "interactive" | string;
  text?: WaText;
  image?: WaMediaRef;
  video?: WaMediaRef;
  audio?: WaMediaRef;
  voice?: WaMediaRef;
  document?: WaMediaRef;
  context?: WaContext;
}

export interface WaContact {
  profile?: { name?: string };
  wa_id: string;
}

export interface WaChange {
  field: "messages";
  value: {
    messaging_product: "whatsapp";
    metadata?: { display_phone_number?: string; phone_number_id?: string };
    contacts?: WaContact[];
    messages?: WaMessage[];
  };
}

export interface WaEntry {
  id: string;
  changes: WaChange[];
}

export interface WaWebhookPayload {
  object: "whatsapp_business_account" | string;
  entry: WaEntry[];
}
