-- Ajoute "virement" (virement bancaire) aux moyens de paiement disponibles
-- pour "Enregistrer un paiement" (cf. migration 0014 pour les précédents) —
-- même principe déclaratif, la référence de transaction existante
-- (payment_reference) sert aussi de référence de virement.
alter table public.payments drop constraint payments_payment_method_check;
alter table public.payments add constraint payments_payment_method_check
  check (payment_method in ('mvola', 'orange_money', 'airtel_money', 'especes', 'virement', 'autre'));
