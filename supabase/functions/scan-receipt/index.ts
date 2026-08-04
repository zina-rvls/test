// Rohy — scan-receipt Edge Function
//
// Lit une photo de ticket de caisse OU un PDF (facture) via un modèle de
// vision/document (Claude, Anthropic) et en extrait le libellé, le montant
// total et la date, pour pré-remplir le formulaire d'ajout de dépense côté
// client — qui reste toujours modifiable avant l'enregistrement. Cette
// fonction ne crée ni ne modifie aucune dépense, elle se contente de lire
// le fichier et de renvoyer les champs devinés.
//
// Déploiement : coller ce fichier dans Supabase Dashboard → Edge Functions
// → scan-receipt → Via Editor (même procédure que pour send-reminder,
// cf. section correspondante du README de ce dossier).
// Secret requis : ANTHROPIC_API_KEY (Dashboard → Edge Functions → Secrets,
// ou `supabase secrets set ANTHROPIC_API_KEY=...`). Sans clé configurée,
// la fonction renvoie une erreur claire (501) plutôt que de planter — la
// saisie manuelle du formulaire reste toujours possible côté client.
// Appel côté client :
//   supabase.functions.invoke('scan-receipt', { body: { image, mimeType } })
//   où `image` est le contenu du fichier encodé en base64 (sans le préfixe
//   "data:...;base64,") et `mimeType` son type MIME (image/jpeg, image/png...
//   ou application/pdf).

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
// Haiku : rapide et nettement moins cher que Sonnet/Opus, largement
// suffisant pour une extraction de champs bornée comme celle-ci. Changer
// cette valeur (ou définir le secret ANTHROPIC_MODEL) pour 'claude-sonnet-5'
// si la précision constatée en pratique ne suffit pas.
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL') || 'claude-haiku-4-5';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

const PROMPT = `Tu regardes soit la photo d'un ticket de caisse, soit un document (facture, souvent en PDF). Réponds UNIQUEMENT avec un objet JSON brut (pas de texte autour, pas de balises markdown), avec exactement ces champs :
{
  "label": string ou null,    // nom du commerce/émetteur de la facture ou description courte (ex. "Carrefour", "Restaurant Le Central") — null si illisible
  "amount": number ou null,   // montant total payé/dû, EN UNITÉ ENTIÈRE de la devise, sans séparateur de milliers — null si illisible
  "date": string ou null,     // date du ticket ou de la facture au format AAAA-MM-JJ — null si illisible ou absente
  "currency": string ou null  // code devise ISO 4217 à 3 lettres si déductible (ex. "EUR", "USD") — sinon null
}
Attention à ne pas confondre séparateur de milliers et virgule décimale : un
point, une virgule ou une espace suivi d'exactement 3 chiffres est presque
toujours un séparateur de milliers, pas une décimale (ex. un montant affichant
"196.720 Ar" ou "196 720 Ar" vaut 196720, PAS 196.72). Ne garde une partie
décimale que si elle a 1 ou 2 chiffres (ex. "42,50 €" vaut 42.5). Prends bien
le montant TOTAL final payé/dû (pas un sous-total ni une ligne de TVA isolée
— pour une facture avec plusieurs pages ou lignes, le total général en bas).
Si le document n'est manifestement ni un ticket de caisse ni une facture,
renvoie null pour tous les champs.`;

const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const PDF_MIME_TYPE = 'application/pdf';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonResponse({ error: 'non authentifié.' }, 401);

    if (!ANTHROPIC_API_KEY) {
      return jsonResponse({ error: 'lecture de ticket non configurée côté serveur (clé API manquante).' }, 501);
    }

    const { image, mimeType } = await req.json();
    if (!image || !mimeType) {
      return jsonResponse({ error: 'image et mimeType sont requis.' }, 400);
    }
    const isPdf = mimeType === PDF_MIME_TYPE;
    if (!isPdf && !ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
      return jsonResponse({ error: 'format non pris en charge (jpeg, png, webp, gif ou pdf attendu).' }, 400);
    }
    // Un PDF est envoyé comme "document" (pas "image") — Claude le lit
    // nativement page par page, pas besoin de le convertir en image côté
    // client ni ici.
    const fileBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: PDF_MIME_TYPE, data: image } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data: image } };

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            fileBlock,
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return jsonResponse({ error: `échec de la lecture du document : ${errText}` }, 502);
    }

    const anthropicData = await anthropicRes.json();
    const textBlock = (anthropicData.content || []).find((b: { type: string }) => b.type === 'text');
    const rawText: string = textBlock ? textBlock.text : '';

    // Extraction défensive : au cas où le modèle ajoute malgré tout du texte
    // ou des balises markdown autour du JSON attendu.
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) return jsonResponse({ error: 'réponse du modèle illisible.' }, 502);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return jsonResponse({ error: 'réponse du modèle mal formée.' }, 502);
    }

    return jsonResponse({
      ok: true,
      label: typeof parsed.label === 'string' ? parsed.label : null,
      amount: typeof parsed.amount === 'number' ? parsed.amount : null,
      date: typeof parsed.date === 'string' ? parsed.date : null,
      currency: typeof parsed.currency === 'string' ? parsed.currency : null,
    });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'erreur inconnue.' }, 500);
  }
});
