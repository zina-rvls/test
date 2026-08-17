// Rohy — merge-guest-profile Edge Function
//
// Fusionne un profil invité (sans compte) dans le compte réel existant qui
// possède l'adresse e-mail qu'on vient de saisir sur cet invité — cas où
// une personne a été ajoutée comme invité (avec historique de dépenses
// déjà enregistré) avant de découvrir qu'elle a déjà un vrai compte
// ailleurs, sans lien avec ce groupe. profiles_email_unique (migration
// 0011) bloque alors la simple saisie de l'e-mail ; cette fonction offre
// le chemin de résolution.
//
// Vérifie côté RLS (via un client "appelant") que l'utilisateur a bien le
// droit de gérer ce profil invité précis (responsable, créateur, ou admin
// d'un groupe partagé — même modèle que les policies profiles_update_*),
// PUIS bascule sur le service role pour retrouver le compte cible par
// e-mail (hors RLS, potentiellement dans des groupes que l'appelant ne
// voit pas) et appeler merge_guest_into_account (migration 0021), qui fait
// la réassignation elle-même dans une seule transaction.
//
// Déploiement : coller ce fichier dans Supabase Dashboard → Edge Functions
// → merge-guest-profile → Via Editor (même procédure que send-reminder,
// cf. section correspondante du README de ce dossier). Nécessite au
// préalable que la migration 0021_merge_guest_profile.sql soit appliquée.
// Appel côté client :
//   supabase.functions.invoke('merge-guest-profile', { body: { guestId, targetEmail } })

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonResponse({ error: 'non authentifié.' }, 401);

    const { guestId, targetEmail } = await req.json();
    if (!guestId || !targetEmail) {
      return jsonResponse({ error: 'guestId et targetEmail sont requis.' }, 400);
    }

    // Client "utilisateur" : respecte les RLS, sert à vérifier que l'appelant
    // a bien le droit de gérer ce profil invité précis avant toute action
    // privilégiée.
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: guestRow, error: guestErr } = await callerClient
      .from('profiles')
      .select('id, auth_user_id, guardian_id, created_by')
      .eq('id', guestId)
      .maybeSingle();
    if (guestErr) return jsonResponse({ error: guestErr.message }, 500);
    if (!guestRow) return jsonResponse({ error: 'profil invité introuvable ou non accessible.' }, 404);
    if (guestRow.auth_user_id) return jsonResponse({ error: 'ce profil a déjà un compte, rien à fusionner.' }, 400);

    const { data: myId, error: myIdErr } = await callerClient.rpc('my_profile_id');
    if (myIdErr) return jsonResponse({ error: myIdErr.message }, 500);

    const { data: canManage, error: canManageErr } = await callerClient.rpc('can_manage_profile', { target: guestId });
    if (canManageErr) return jsonResponse({ error: canManageErr.message }, 500);

    const authorized = canManage || guestRow.guardian_id === myId || guestRow.created_by === myId;
    if (!authorized) return jsonResponse({ error: "tu n'as pas les droits pour fusionner ce profil." }, 403);

    // Client "service role" : contourne les RLS pour retrouver le compte
    // cible par e-mail (potentiellement hors des groupes de l'appelant) et
    // effectuer la fusion elle-même.
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: targetProfile, error: lookupError } = await adminClient
      .from('profiles')
      .select('id, name, auth_user_id')
      .eq('email', targetEmail)
      .maybeSingle();
    if (lookupError) return jsonResponse({ error: lookupError.message }, 500);
    if (!targetProfile || !targetProfile.auth_user_id) {
      return jsonResponse({ error: 'aucun compte existant ne correspond à cette adresse.' }, 404);
    }
    if (targetProfile.id === guestId) {
      return jsonResponse({ error: 'profil source et cible identiques.' }, 400);
    }

    const { error: mergeError } = await adminClient.rpc('merge_guest_into_account', {
      guest_id: guestId,
      target_id: targetProfile.id,
    });
    if (mergeError) return jsonResponse({ error: mergeError.message }, 500);

    return jsonResponse({ ok: true, targetName: targetProfile.name });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : 'erreur inconnue.' }, 500);
  }
});
