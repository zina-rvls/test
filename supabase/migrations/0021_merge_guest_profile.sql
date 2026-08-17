-- Fusionne un profil invité (sans compte) dans un compte réel existant —
-- cas où quelqu'un a été ajouté comme invité (avec historique de dépenses)
-- avant qu'on découvre que cette personne a déjà un vrai compte ailleurs
-- (son e-mail entre alors en conflit avec profiles_email_unique, migration
-- 0011, sans offrir de solution jusqu'ici).
--
-- SECURITY DEFINER, appelée uniquement par le service role depuis l'Edge
-- Function merge-guest-profile (jamais directement par le client — EXECUTE
-- retiré de public/anon/authenticated ci-dessous) : la fonction contourne
-- volontairement les RLS pour réassigner l'historique du profil invité
-- (paiements, dépenses, rappels...) vers le compte cible, potentiellement
-- hors des groupes de l'appelant. Les vérifications d'autorisation
-- (l'appelant a bien le droit de gérer ce profil invité précis) restent
-- faites côté Edge Function, avant tout appel ici.
create or replace function public.merge_guest_into_account(guest_id uuid, target_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if guest_id = target_id then
    raise exception 'Impossible de fusionner un profil avec lui-même.';
  end if;
  if not exists (select 1 from public.profiles where id = guest_id and auth_user_id is null) then
    raise exception 'Le profil source doit être un invité sans compte.';
  end if;
  if not exists (select 1 from public.profiles where id = target_id and auth_user_id is not null) then
    raise exception 'Le profil cible doit être un compte existant.';
  end if;

  -- Groupes : le compte cible hérite des groupes de l'invité où il n'est
  -- pas déjà membre ; la ligne d'origine est de toute façon supprimée en
  -- fin de fonction avec le profil invité (contrainte on delete cascade).
  update public.group_members set user_id = target_id
    where user_id = guest_id
      and group_id not in (select group_id from public.group_members where user_id = target_id);

  -- Dépenses payées par l'invité.
  update public.expenses set paid_by = target_id where paid_by = guest_id;

  -- Participation aux dépenses (garde la ligne du compte cible si les deux
  -- participaient déjà à la même dépense — cas rare mais possible).
  update public.expense_participants set user_id = target_id
    where user_id = guest_id
      and expense_id not in (select expense_id from public.expense_participants where user_id = target_id);
  update public.expense_participants set override_responsible_id = target_id
    where override_responsible_id = guest_id;

  -- Paiements et rappels envoyés/reçus par l'invité.
  update public.payments set from_user = target_id where from_user = guest_id;
  update public.payments set to_user = target_id where to_user = guest_id;
  update public.reminders set from_user = target_id where from_user = guest_id;
  update public.reminders set to_user = target_id where to_user = guest_id;

  -- Personnes à charge dont l'invité était le responsable, et profils créés
  -- par l'invité (ne devrait normalement pas arriver pour un invité sans
  -- compte, mais réassigné par sécurité plutôt que laissé en référence
  -- fantôme après suppression).
  update public.profiles set guardian_id = target_id where guardian_id = guest_id;
  update public.profiles set created_by = target_id where created_by = guest_id;

  -- Foyer : le compte cible garde le sien s'il en a déjà un, sinon hérite
  -- de celui de l'invité.
  update public.profiles set household_id = (select household_id from public.profiles where id = guest_id)
    where id = target_id and household_id is null
      and (select household_id from public.profiles where id = guest_id) is not null;

  -- Le profil invité, maintenant vide, est supprimé pour de bon — group_members
  -- restants (s'il en reste, normalement aucun après la réassignation
  -- ci-dessus) et expense_participants restants suivent en cascade.
  delete from public.profiles where id = guest_id;
end;
$$;

revoke execute on function public.merge_guest_into_account(uuid, uuid) from public, anon, authenticated;
