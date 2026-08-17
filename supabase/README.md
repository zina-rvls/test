# Rohy — backend Supabase (P0)

Ce dossier contient tout ce qu'il faut pour le vrai backend (auth, base de
données, invitations par e-mail) qui remplace le `localStorage` du
prototype front-end. Le front-end (`index.html`, `scripts/`) reste hébergé
tel quel (ex. GitHub Pages) ; seul Supabase héberge la base et l'auth.

## 1. Créer le projet

1. Va sur [supabase.com](https://supabase.com), crée un compte (gratuit) et
   un nouveau projet.
2. Note l'**URL du projet** et la **clé publique `anon`** — Project Settings
   → API. Ce sont les deux seules valeurs à partager pour brancher le
   front-end (elles sont conçues pour être publiques/côté client).
3. Ne partage jamais la **clé `service_role`** — elle donne un accès total à
   la base et ne doit exister que côté serveur (Edge Functions).

## 2. Appliquer le schéma

Dans le dashboard Supabase → SQL Editor, colle et exécute **dans l'ordre**
`migrations/0001_init.sql`, PUIS `0002_admin_manage_share.sql`, PUIS
`0003_group_admin_select.sql`, PUIS `0004_households_dependents_weights.sql`,
PUIS `0005_households_scoped_to_group.sql`, PUIS
`0006_participant_type_two_values.sql`, PUIS `0007_drop_participant_type.sql`,
PUIS `0008_guest_members_no_email.sql`, PUIS `0009_expense_receipts.sql`,
PUIS `0010_expense_split_modes.sql`, PUIS `0011_profiles_email_unique.sql`,
PUIS `0012_rebrand_profile_colors.sql`, PUIS
`0013_link_guest_profile_on_signup.sql`, PUIS
`0014_payment_method_reference.sql`, PUIS
`0015_cascade_delete_group_payments_reminders.sql`, PUIS
`0016_group_share_link.sql`, PUIS
`0017_fix_handle_new_user_regression.sql`, PUIS `0018_feedback.sql`, PUIS
`0019_expense_currency_conversion.sql`, PUIS
`0020_payment_method_add_virement.sql`, PUIS
`0021_merge_guest_profile.sql`
(ou, avec la CLI Supabase installée : `supabase link --project-ref <ref>`
puis `supabase db push`).

**Important pour `0016`** : nécessite aussi d'activer l'authentification
anonyme (Dashboard → Authentication), cf. section 3.

**`0017` est urgente si `0016` a déjà été appliquée** : le trigger que
`0016` recréait était basé sur une copie obsolète (celle de `0001`),
antérieure aux corrections de `0004` (colonne renommée en `share_weight`)
et `0013` (rattachement d'un profil invité existant) — résultat, **toute
inscription** (pas seulement le compte anonyme) échouait avec une erreur
500 sur `/auth/v1/signup` (`column "share_percent" does not exist`).
`0017` restaure la bonne logique.

`0001_init.sql` crée :
- `profiles`, `groups`, `group_members`, `expenses`, `expense_participants`,
  `payments`, `reminders` — cf. commentaires dans le fichier pour le détail.
- Un trigger qui crée automatiquement une ligne `profiles` à l'inscription
  de chaque utilisateur (mot de passe, lien magique ou invitation — tous
  passent par `auth.users`).
- Les policies RLS : chacun ne voit que ses groupes et les personnes qui les
  partagent avec lui ; seul l'admin d'un groupe peut le modifier/supprimer
  ou y ajouter des membres.

`0002_admin_manage_share.sql` ajoute :
- La possibilité pour l'admin d'un groupe de modifier la part de
  contribution d'un co-membre depuis "gérer les membres".
- Une colonne `email` sur `profiles`, utilisée pour retrouver le compte
  existant d'une personne ré-invitée dans un autre groupe.

`0003_group_admin_select.sql` corrige la policy de lecture des groupes pour
que l'admin voie bien le groupe qu'il vient de créer (`INSERT ... RETURNING`).

`0004_households_dependents_weights.sql` ajoute la gestion des foyers, des
personnes à charge (profils sans compte de connexion) et des coefficients de
part relatifs (`share_weight`, qui remplace `share_percent`) — cf. les
commentaires en tête du fichier pour le détail des changements.

`0005_households_scoped_to_group.sql` rattache chaque foyer à un groupe
(`households.group_id`, obligatoire) : un foyer créé dans un groupe n'est
plus visible ni sélectionnable depuis un autre groupe, au même titre que les
membres.

`0006_participant_type_two_values.sql` retire `personne_a_charge` des
valeurs possibles de `participant_type` (ne reste plus que `adulte`/`enfant`)
— la prise en charge était déjà entièrement portée par `guardian_id`,
indépendamment de la catégorie d'âge ; la présenter comme un 3e "type" au
même niveau qu'adulte/enfant était source de confusion. Les profils existants
avec `personne_a_charge` sont migrés vers `enfant`.

`0007_drop_participant_type.sql` retire complètement la colonne
`participant_type` : elle ne pilotait aucun calcul ni aucune règle de l'app
(le calcul dépend uniquement de `share_weight` et `guardian_id`), et n'était
donc qu'un libellé descriptif redondant avec la notion de coefficient/part
et de responsable déjà en place.

`0008_guest_members_no_email.sql` fusionne les anciens flux "inviter par
e-mail" et "ajouter une personne à charge" en un seul formulaire "+ ajouter
un membre" côté front-end (e-mail et responsable désormais tous les deux
facultatifs) : un membre sans e-mail n'a donc plus forcément de
responsable — ça peut être un simple "invité" dont la part est suivie
manuellement, réglée hors app. Ajoute une colonne `created_by` sur
`profiles` (qui a créé un profil sans compte pour le compte de qui, utile
pour la policy de lecture juste après l'`INSERT ... RETURNING`, avant que
le nouveau profil ne partage un groupe avec son créateur) et une policy
`profiles_insert_guest` dédiée à ce cas (l'ancienne `profiles_insert_dependent`
de `0004_households_dependents_weights.sql` exige toujours `guardian_id`
non nul, et reste inchangée pour le cas classique d'une personne à charge).

`0009_expense_receipts.sql` ajoute la possibilité de joindre un reçu/pièce
jointe à une dépense : colonne `expenses.receipt_path`, bucket de stockage
privé `receipts` (pas d'URL publique — la consultation passe par des URLs
signées à durée limitée) et policies sur `storage.objects` scoping l'accès
au groupe du chemin déposé (convention `{group_id}/{nom de fichier}`, les
droits calqués sur ceux des dépenses : tout membre du groupe, pas seulement
l'admin ni l'auteur). Rien à configurer manuellement côté dashboard, le
bucket est créé par la migration elle-même.

`0010_expense_split_modes.sql` ajoute la possibilité de choisir, pour une
dépense précise, un mode de répartition différent du poids permanent
(`share_weight`) — colonne `expenses.split_mode` (`'default'` par défaut,
ou `'equal'`/`'shares'`/`'exact'`/`'percent'`) et `expense_participants.split_value`
(le poids ponctuel, montant exact ou pourcentage selon le mode). Migration
purement additive : toute dépense existante garde `split_mode = 'default'`
et `split_value = null`, donc un comportement strictement inchangé (cf.
`scripts/calc.js`, `computeShares`).

## 3. Configurer l'authentification

Authentication → Providers → Email : active à la fois **Password** et
**Magic Link / OTP** (les deux modes prévus par la spec de hand-off).

Authentication → Sign In / Providers → active **Anonymous Sign-Ins**
(désactivée par défaut) — nécessaire pour le lien d'invitation par groupe
(cf. `0016_group_share_link.sql` et section 7) : sans elle,
`signInAnonymously()` échoue côté client et personne ne peut rejoindre un
groupe par lien sans déjà avoir un compte.

Authentication → URL Configuration : renseigne l'URL du front-end déployé
(Site URL) et ajoute-la aux Redirect URLs, sinon les liens des e-mails
(invitation, lien magique) ne redirigeront pas au bon endroit. Domaine
définitif : `https://rohy-app.com` (remplace l'ancienne URL GitHub Pages
`zina-rvls.github.io/test`) — à mettre à jour ici dès que le domaine
répond (propagation DNS + `CNAME` du dépôt, cf. README racine).

**E-mail** : Supabase envoie les e-mails par défaut avec un service partagé
très limité en volume (quelques e-mails/heure) — suffisant pour tester,
mais pas pour un usage réel. Pour la suite, brancher un vrai SMTP
(Project Settings → Auth → SMTP Settings) via un service comme Resend,
Postmark ou Brevo (tous ont un tier gratuit largement suffisant pour un
usage entre amis).

## 4. Déployer la fonction d'invitation

`functions/invite-member/index.ts` vérifie que l'appelant est bien admin du
groupe, crée le compte de la personne invitée (`auth.admin.inviteUserByEmail`,
avec la clé service role — jamais exposée au client), puis l'ajoute au
groupe. Les variables `SUPABASE_URL`, `SUPABASE_ANON_KEY` et
`SUPABASE_SERVICE_ROLE_KEY` sont injectées automatiquement par Supabase dans
l'environnement de la fonction : rien à configurer manuellement.

```
supabase functions deploy invite-member --project-ref <ref>
```

## 5. Déployer la fonction d'envoi de rappel

`functions/send-reminder/index.ts` enregistre un rappel de paiement (table
`reminders`) et tente en plus l'envoi d'un vrai e-mail au destinataire s'il a
un compte avec une adresse connue — via [Resend](https://resend.com) (tier
gratuit largement suffisant). Vérifie que l'appelant est authentifié et
partage bien un groupe avec le destinataire (même garde-fou que les
policies RLS `profiles_select`/`reminders_insert`) avant d'agir.

```
supabase functions deploy send-reminder --project-ref <ref>
supabase secrets set RESEND_API_KEY=<ta clé Resend> --project-ref <ref>
```

`RESEND_API_KEY` est **optionnelle** : sans elle, le rappel est quand même
enregistré dans l'app (comportement inchangé), l'envoi d'e-mail est
simplement sauté. `REMINDER_EMAIL_FROM` (optionnelle aussi, ex.
`"Rohy <rappels@tondomaine.com>"`) permet de personnaliser l'expéditeur
une fois un domaine vérifié sur Resend ; par défaut, l'adresse de test
`onboarding@resend.dev` de Resend est utilisée (fonctionne sans domaine
vérifié, mais uniquement en test).

`0011_profiles_email_unique.sql` ajoute une contrainte unique sur
`profiles.email` (les `NULL` restent autorisés en plusieurs exemplaires) :
rien n'empêchait jusque-là deux profils sans compte de partager la même
adresse (renseignée après coup via "gérer les membres"), ce qui aurait pu
poser problème pour le dédoublonnage de `invite-member` et pour l'envoi de
rappels (deux personnes différentes recevant leurs rappels à la même
adresse). La migration nettoie d'abord les doublons déjà présents (garde
l'e-mail sur le profil le plus ancien, le retire des autres) avant
d'ajouter la contrainte.

`0012_rebrand_profile_colors.sql` remplace l'ancienne palette de couleurs
d'avatar (posée avant l'envoi de la charte graphique de la marque) par une
palette dérivée des 4 teintes du logo tissé. Trois changements : la valeur
par défaut de `profiles.color`, le trigger `handle_new_user` (utilisé
notamment par la connexion par lien magique, qui ne fournit pas de couleur
dans ses métadonnées), et une réattribution en une fois de la nouvelle
palette à tous les profils déjà créés (en cycle, par ordre de création,
pour que des profils voisins dans un même groupe restent visuellement
distincts). Testée de bout en bout sur un schéma Postgres local reproduisant
exactement celui de production avant d'être livrée.

`0013_link_guest_profile_on_signup.sql` corrige un bug bloquant découvert en
conditions réelles : une personne ayant déjà un profil "invité sans compte"
(créé via "+ ajouter un membre", ou dont l'e-mail a été renseigné après coup
dans "gérer les membres") ne pouvait pas créer son propre compte avec cette
même adresse — la création de compte (lien magique, mot de passe, ou
ré-invitation) échouait avec `duplicate key value violates unique
constraint "profiles_email_unique"`, bloquant l'inscription. Le trigger
`handle_new_user` insérait toujours un nouveau profil sans vérifier qu'un
profil "invité" avec cette adresse existait déjà. Corrigé : si c'est le cas
(et qu'il n'a pas encore de compte), on le rattache au nouveau compte
(`auth_user_id`) plutôt que d'en créer un doublon — son nom, sa couleur, sa
part et son historique de groupes/dépenses (tous rattachés à son `id`,
inchangé) sont conservés. Testée de bout en bout sur un schéma Postgres
local reproduisant exactement ce scénario (profil invité existant, puis
inscription réelle avec la même adresse) avant d'être livrée.

`0014_payment_method_reference.sql` ajoute `payments.payment_method`
(MVola/Orange Money/Airtel Money/Espèces/Autre, contrainte de valeurs) et
`payments.payment_reference` (texte libre) — traçabilité du règlement
d'une dette, cf. discussion mobile money. Aucune intégration à une
passerelle de paiement : le formulaire de règlement propose juste
d'ouvrir le clavier téléphone avec le code USSD de l'opérateur choisi
(`tel:*111#` etc.), la confirmation reste entièrement manuelle.

`0015_cascade_delete_group_payments_reminders.sql` corrige un bug de
cohérence : supprimer un groupe supprimait déjà (cascade) ses dépenses,
mais ses règlements (`payments`) survivaient avec `group_id` mis à `null`
(`on delete set null`) — ils continuaient donc d'alimenter le calcul de
solde "tous groupes confondus" et l'écran Historique même après
suppression complète des groupes d'un compte. `payments.group_id` passe
maintenant en `on delete cascade`, comme `expenses.group_id`. `reminders`
gagne aussi une colonne `group_id` (nullable, `on delete cascade`),
remplie uniquement quand le rappel est envoyé depuis un écran filtré sur
un groupe précis — un rappel envoyé depuis la vue "tous groupes
confondus" n'est lié à aucun groupe et n'est donc concerné par aucune
cascade. **Nécessite aussi de redéployer `send-reminder`** (accepte et
enregistre désormais un `groupId` optionnel).

`0016_group_share_link.sql` ajoute `groups.share_token` (jeton unique,
régénérable, nullable) pour le lien d'invitation façon Tricount/Kittysplit :
contrairement à l'invitation par e-mail (crée un compte, envoie un
e-mail) ou au membre "invité sans compte" (une fiche que l'admin gère à sa
place, sans accès propre), la personne qui ouvre ce lien devient un vrai
participant — elle voit ses dépenses et son solde, et peut en ajouter —
sans jamais créer de compte e-mail/mot de passe, via l'authentification
anonyme de Supabase (`signInAnonymously`, cf. section 3). Une vraie session
est créée, donc les policies RLS existantes n'ont pas eu besoin de changer.
Un compte anonyme peut ensuite être transformé en compte permanent
(bouton "Créer un compte" du menu, `auth.updateUser`) en conservant le même
`id`, donc tout son historique. La migration ajoute aussi un dernier repli
`'Invité'` au trigger `handle_new_user` (un compte anonyme n'a pas d'e-mail,
donc l'ancien repli `split_part(new.email, ...)` ne suffisait pas).

⚠️ Le trigger réécrit par `0016` était basé par erreur sur une copie
obsolète (celle de `0001`) — voir `0017` ci-dessous, qui corrige une
régression bloquante introduite par cette erreur.

`0017_fix_handle_new_user_regression.sql` corrige `handle_new_user` : la
version de `0016` insérait dans `profiles.share_percent`, une colonne
renommée en `share_weight` depuis `0004` — chaque inscription (anonyme ou
non) échouait donc avec une erreur 500 sur `/auth/v1/signup` (`column
"share_percent" does not exist`). Cette version restaure aussi le
rattachement d'un profil "invité sans compte" existant à son nouveau
compte (logique de `0013`, également perdue par erreur dans `0016`) et le
lien `auth_user_id` (logique de `0004`). Seul ajout réel par rapport à
`0013` : un dernier repli `'Invité'` si ni e-mail ni nom ne sont fournis
(cas d'un compte anonyme).

`0018_feedback.sql` ajoute une table `feedback` (note 1-5 + commentaire
facultatif + contexte `'settle'`/`'menu'`) pour recueillir des avis in-app
sans passer par un store (App Store/Play Store) — écriture seule pour les
utilisateurs, lue uniquement via le dashboard Supabase (SQL/Table editor,
accès `service_role`).

`0019_expense_currency_conversion.sql` ajoute la conversion de devise par
dépense : `expenses.original_currency`/`original_amount`/`exchange_rate`
(métadonnées d'affichage et d'historique, `amount` reste dans la devise du
groupe et alimente `scripts/calc.js` sans changement), `groups.freeze_currency_rates`
(option pour réutiliser le dernier taux connu d'une devise plutôt que d'en
rechercher un nouveau à chaque dépense), et la table `group_currency_rates`
(un taux par devise et par groupe, RLS identique aux autres tables scopées
par groupe).

## 6. Déployer la fonction de lecture de ticket (scan-receipt)

`functions/scan-receipt/index.ts` lit une photo de ticket de caisse OU un PDF
(facture) via Claude (Anthropic) et renvoie le libellé, le montant total, la
date et la devise devinés — utilisés pour pré-remplir le formulaire d'ajout
de dépense côté client (qui reste toujours modifiable avant
l'enregistrement). Un PDF est envoyé comme document (pas comme image) ;
Claude le lit nativement, page par page. Vérifie seulement que l'appelant
est authentifié, aucune autre donnée n'est lue ou modifiée.

```
supabase functions deploy scan-receipt --project-ref <ref>
supabase secrets set ANTHROPIC_API_KEY=<ta clé Anthropic> --project-ref <ref>
```

`ANTHROPIC_API_KEY` est **requise** pour que la lecture fonctionne : clé
créée sur [console.anthropic.com](https://console.anthropic.com) (Settings →
API Keys). Sans elle, la fonction renvoie une erreur claire au clic sur
"Scanner un ticket", mais la saisie manuelle du formulaire reste toujours
possible — rien d'autre dans l'app n'est affecté. `ANTHROPIC_MODEL`
(optionnelle, défaut `claude-haiku-4-5`) permet de passer sur un modèle plus
précis (ex. `claude-sonnet-5`) si la lecture s'avère peu fiable en pratique,
au prix d'un coût par appel plus élevé.

Corrigé : sur un ticket affichant un montant avec un séparateur de milliers
(ex. `196 720 Ar` ou `196.720 Ar`), le modèle confondait parfois ce
séparateur avec une virgule décimale et renvoyait `196.72` au lieu de
`196720`. Le prompt précise désormais explicitement la distinction
(un séparateur suivi d'exactement 3 chiffres est un groupement de
milliers, pas une décimale) avec un exemple correspondant à ce cas précis.

Ajouté : prise en charge des factures PDF en plus des photos de ticket
(`application/pdf` envoyé comme bloc `document`, pas `image`) — nécessite de
redéployer cette fonction (`supabase functions deploy scan-receipt
--project-ref <ref>`, ou copier-coller le fichier mis à jour dans le
Dashboard) pour que le changement prenne effet ; le reste de l'app
(hébergée sur GitHub Pages) ne redéploie pas cette fonction automatiquement.

## 7. Déployer la fonction du lien d'invitation (join-group)

`functions/join-group/index.ts` gère le lien d'invitation par groupe (cf.
`0016_group_share_link.sql`) : un non-membre ne peut normalement ni lire un
groupe (`groups_select` réservée aux membres) ni s'y ajouter lui-même
(`group_members_insert_admin` réservée à l'admin) — cette fonction
contourne volontairement ces deux garde-fous, mais seulement pour quelqu'un
qui présente un jeton `share_token` valide. Deux actions : `preview`
(nom/devise/nombre de membres du groupe, sans rien modifier — affiche
"Vous rejoignez tel groupe" avant confirmation) et `join` (ajoute
réellement l'appelant, et renseigne son prénom s'il n'en a pas encore).

```
supabase functions deploy join-group --project-ref <ref>
```

Rien à configurer en plus (pas de secret) — mais rappel : nécessite
l'authentification anonyme activée, cf. section 3.

## 8. Déployer la fonction de suppression de compte (delete-account)

`functions/delete-account/index.ts` — droit à l'effacement RGPD.
L'identité vient uniquement du JWT de l'appelant (jamais d'un id transmis
par le client) : quitte chaque groupe dont elle est membre (transfère
l'administration au membre le plus ancien si elle en est admin et qu'il en
reste d'autres, sinon supprime le groupe entier), anonymise son profil
(nom → « Compte supprimé », e-mail retiré, lien vers le compte auth
rompu), puis supprime réellement le compte `auth.users` (connexion
impossible ensuite). La ligne `profiles` elle-même n'est jamais
supprimée — `paid_by`/`admin_id`/`from_user`/`to_user` n'ont pas de
cascade dessus, un hard delete casserait l'historique des autres membres.

```
supabase functions deploy delete-account --project-ref <ref>
```

Rien à configurer en plus (pas de secret).

## 9. Déployer la fonction de fusion de profil invité (merge-guest-profile)

`functions/merge-guest-profile/index.ts` — fusionne un profil invité (sans
compte) dans le compte réel existant qui possède l'adresse e-mail qu'on
vient de saisir sur cet invité (cas où quelqu'un a été ajouté comme invité,
avec historique de dépenses déjà enregistré, avant de découvrir qu'il a
déjà un vrai compte ailleurs — `profiles_email_unique`, migration 0011,
bloque alors la simple saisie de l'e-mail sans offrir de solution).

Vérifie via un client "appelant" (respecte les RLS) que l'utilisateur a
bien le droit de gérer ce profil invité précis (responsable, créateur, ou
admin d'un groupe partagé), puis bascule sur le service role pour
retrouver le compte cible par e-mail et appeler
`merge_guest_into_account` (migration 0021, `SECURITY DEFINER`, EXECUTE
retiré de `public`/`anon`/`authenticated` — appelable uniquement par le
service role) qui réassigne dépenses/paiements/rappels/foyer vers le
compte cible dans une seule transaction, puis supprime le profil invité
devenu vide.

```
supabase functions deploy merge-guest-profile --project-ref <ref>
```

Rien à configurer en plus (pas de secret). Nécessite que la migration
`0021_merge_guest_profile.sql` soit appliquée avant le premier appel.

## 10. Front-end branché

`scripts/app.js` appelle désormais Supabase directement (`scripts/supabase-client.js`
contient l'URL du projet et la clé publiable) : vraie inscription/connexion
(mot de passe, lien magique, ou création de compte), chargement des données
depuis les tables au lieu de `localStorage`, et appel de `invite-member`
pour inviter des membres à la création d'un groupe.

**Si tu avais déjà déployé `invite-member` avant l'ajout de la colonne
`email` et de la couleur d'avatar** (cf. `0002_admin_manage_share.sql`),
redéploie la fonction avec le contenu à jour de
`functions/invite-member/index.ts` pour que les ré-invitations (une
personne déjà membre d'un autre groupe) et les couleurs d'avatar variées
fonctionnent.
