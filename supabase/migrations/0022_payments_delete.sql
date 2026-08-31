-- Corrige un bug : supprimer un remboursement (cf. confirmDeletePayment côté
-- client, écran Groupe > nom du groupe) affichait bien le toast de succès,
-- mais la ligne restait en base et continuait de s'afficher — RLS étant
-- activé sur payments sans aucune policy "delete", Postgres exécute le
-- DELETE sans erreur mais ne supprime 0 ligne (silencieux, pas d'erreur
-- remontée par PostgREST).
--
-- Même périmètre que payments_select (cf. 0001_init.sql) : les deux
-- personnes concernées par le remboursement, ou n'importe quel membre du
-- groupe auquel il est rattaché (aligné sur expenses_delete, qui autorise
-- déjà tout membre du groupe à supprimer une dépense).
create policy "payments_delete" on public.payments
  for delete using (
    from_user = auth.uid() or to_user = auth.uid()
    or (group_id is not null and public.is_group_member(group_id))
  );
