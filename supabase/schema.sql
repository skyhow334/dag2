-- =====================================================================
--  ПЕКАРНЯ DAG — схема базы данных для Supabase
--  Как применить: Supabase → SQL Editor → New query → вставить всё → Run
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Администраторы
--    Таблица закрыта для API полностью (RLS включён, политик нет).
--    Проверка прав идёт только через функцию is_admin().
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Меню
-- ---------------------------------------------------------------------
create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 500),
  price       numeric(10,2) not null check (price >= 0),
  category    text not null default 'Выпечка' check (char_length(category) between 1 and 40),
  emoji       text not null default '🥐',
  image_url   text,
  available   boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);
alter table public.products enable row level security;

drop policy if exists "products: все читают" on public.products;
create policy "products: все читают"
  on public.products for select
  using (true);

drop policy if exists "products: пишет только админ" on public.products;
create policy "products: пишет только админ"
  on public.products for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------
-- 3. Заказы
--    Напрямую читать и писать может только админ.
--    Клиенты создают заказ через функцию create_order() ниже.
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  customer_name text not null,
  phone         text not null,
  method        text not null check (method in ('pickup', 'delivery')),
  address       text not null default '',
  comment       text not null default '',
  items         jsonb not null,
  total         numeric(10,2) not null,
  status        text not null default 'new'
                check (status in ('new', 'cooking', 'ready', 'done', 'cancelled'))
);
create index if not exists orders_created_idx on public.orders (created_at desc);
alter table public.orders enable row level security;

drop policy if exists "orders: только админ" on public.orders;
create policy "orders: только админ"
  on public.orders for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------
-- 4. Создание заказа клиентом.
--    Цены и наличие берутся из базы, а не от браузера,
--    поэтому подменить цену в запросе нельзя.
-- ---------------------------------------------------------------------
create or replace function public.create_order(
  p_name    text,
  p_phone   text,
  p_method  text,
  p_address text,
  p_comment text,
  p_items   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric(10,2) := 0;
  v_items jsonb := '[]'::jsonb;
  v_row   record;
  v_qty   int;
  v_it    jsonb;
  v_id    uuid;
begin
  if char_length(trim(coalesce(p_name, ''))) < 1 or char_length(p_name) > 80 then
    raise exception 'invalid_name';
  end if;
  if char_length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) < 6
     or char_length(p_phone) > 30 then
    raise exception 'invalid_phone';
  end if;
  if p_method not in ('pickup', 'delivery') then
    raise exception 'invalid_method';
  end if;
  if p_method = 'delivery' and char_length(trim(coalesce(p_address, ''))) < 3 then
    raise exception 'invalid_address';
  end if;
  if char_length(coalesce(p_address, '')) > 200 or char_length(coalesce(p_comment, '')) > 500 then
    raise exception 'too_long';
  end if;
  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 50 then
    raise exception 'invalid_items';
  end if;

  -- защита от спама: не больше 5 заказов с одного телефона за 10 минут
  if (select count(*) from public.orders
        where phone = trim(p_phone)
          and created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'too_many_orders';
  end if;

  for v_it in select value from jsonb_array_elements(p_items) loop
    v_qty := (v_it ->> 'qty')::int;
    if v_qty is null or v_qty < 1 or v_qty > 99 then
      raise exception 'invalid_qty';
    end if;

    select pr.id, pr.name, pr.price into v_row
      from public.products pr
     where pr.id = (v_it ->> 'id')::uuid and pr.available;
    if not found then
      raise exception 'product_unavailable';
    end if;

    v_total := v_total + v_row.price * v_qty;
    v_items := v_items || jsonb_build_object(
      'id', v_row.id, 'name', v_row.name, 'price', v_row.price, 'qty', v_qty
    );
  end loop;

  insert into public.orders (customer_name, phone, method, address, comment, items, total)
  values (trim(p_name), trim(p_phone), p_method,
          case when p_method = 'delivery' then trim(p_address) else '' end,
          trim(coalesce(p_comment, '')), v_items, v_total)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'total', v_total);
end;
$$;

revoke all on function public.create_order(text, text, text, text, text, jsonb) from public;
grant execute on function public.create_order(text, text, text, text, text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Статус заказа для клиента.
--    Клиент знает только идентификатор своего заказа (длинный случайный
--    UUID), чужие заказы увидеть нельзя.
-- ---------------------------------------------------------------------
create or replace function public.order_status(p_ids uuid[])
returns table (id uuid, status text, created_at timestamptz, total numeric)
language sql
security definer
set search_path = public
as $$
  select o.id, o.status, o.created_at, o.total
    from public.orders o
   where o.id = any (p_ids)
   order by o.created_at desc
   limit 30;
$$;

revoke all on function public.order_status(uuid[]) from public;
grant execute on function public.order_status(uuid[]) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Хранилище фотографий блюд
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

drop policy if exists "product-images: все смотрят" on storage.objects;
create policy "product-images: все смотрят"
  on storage.objects for select
  using (bucket_id = 'product-images');

drop policy if exists "product-images: загружает админ" on storage.objects;
create policy "product-images: загружает админ"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "product-images: меняет админ" on storage.objects;
create policy "product-images: меняет админ"
  on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

drop policy if exists "product-images: удаляет админ" on storage.objects;
create policy "product-images: удаляет админ"
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and public.is_admin());

-- ---------------------------------------------------------------------
-- 7. Мгновенные обновления (новые заказы в панели, меню на витрине)
-- ---------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.orders;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.products;
exception when duplicate_object then null; end $$;

-- =====================================================================
--  ГОТОВО. Следующий шаг — сделать себя админом (см. README.md, шаг 3):
--
--  insert into public.admins (user_id)
--  select id from auth.users where email = 'ВАША_ПОЧТА@example.com';
-- =====================================================================
