-- Baseline schema for the DAM platform.
-- Derived from dam_backup.sql (pg_dump, 2026-07-27).
-- OWNER TO statements stripped so this applies as whatever role runs it.
-- MUST be verified against the live database before any production restore.

--
-- PostgreSQL database dump
--

-- (removed) \restrict : a psql client meta-command emitted by pg_dump 18, not SQL. The pg driver cannot execute it, so scripts/migrate.mjs failed with a syntax error. Safe to drop -- it is a psql session directive, not schema.

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: dam
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;



SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: access_log; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.access_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    tenant_id uuid,
    resource_id uuid,
    action text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb
);



--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    action text NOT NULL,
    resource_id uuid,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



--
-- Name: collection_resource; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.collection_resource (
    collection_id uuid NOT NULL,
    resource_id uuid NOT NULL
);



--
-- Name: collections; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.collections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    owner_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_id uuid,
    cover_storage_key text
);



--
-- Name: email_tokens; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.email_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    purpose text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    new_email text,
    CONSTRAINT email_tokens_purpose_check CHECK ((purpose = ANY (ARRAY['verify'::text, 'reset'::text, 'email_change'::text])))
);



--
-- Name: invitations; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    email text NOT NULL,
    tenant_id uuid CONSTRAINT invitations_company_id_not_null NOT NULL,
    role_id integer NOT NULL,
    invited_by uuid,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);



--
-- Name: metadata_fields; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.metadata_fields (
    id integer NOT NULL,
    name text NOT NULL,
    field_type text DEFAULT 'text'::text NOT NULL,
    searchable boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    options jsonb,
    required boolean DEFAULT false NOT NULL,
    exif_source text,
    tenant_id uuid
);



--
-- Name: metadata_fields_id_seq; Type: SEQUENCE; Schema: public; Owner: dam
--

CREATE SEQUENCE public.metadata_fields_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: metadata_fields_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: dam
--

ALTER SEQUENCE public.metadata_fields_id_seq OWNED BY public.metadata_fields.id;


--
-- Name: renditions; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.renditions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    resource_id uuid NOT NULL,
    kind text NOT NULL,
    storage_key text NOT NULL,
    mime_type text,
    width integer,
    height integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT renditions_kind_check CHECK ((kind = ANY (ARRAY['thumbnail'::text, 'preview'::text])))
);



--
-- Name: resource_field_data; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.resource_field_data (
    resource_id uuid NOT NULL,
    field_id integer NOT NULL,
    value text
);



--
-- Name: resource_types; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.resource_types (
    id integer NOT NULL,
    name text NOT NULL
);



--
-- Name: resource_types_id_seq; Type: SEQUENCE; Schema: public; Owner: dam
--

CREATE SEQUENCE public.resource_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;



--
-- Name: resource_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: dam
--

ALTER SEQUENCE public.resource_types_id_seq OWNED BY public.resource_types.id;


--
-- Name: resources; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.resources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    resource_type_id integer,
    title text,
    original_filename text NOT NULL,
    storage_key text NOT NULL,
    checksum_sha256 text,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    status text DEFAULT 'uploading'::text NOT NULL,
    width integer,
    height integer,
    duration_seconds numeric(10,2),
    description text,
    extracted_text text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS ((((setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(original_filename, ''::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(description, ''::text)), 'C'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(extracted_text, ''::text)), 'D'::"char"))) STORED,
    thumbnail_storage_key text,
    CONSTRAINT resources_status_check CHECK ((status = ANY (ARRAY['uploading'::text, 'processing'::text, 'ready'::text, 'failed'::text])))
);



--
-- Name: roles; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.roles (
    id integer NOT NULL,
    name text NOT NULL
);



--
-- Name: shares; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.shares (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    collection_id uuid,
    resource_id uuid,
    access_level text NOT NULL,
    expires_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked boolean DEFAULT false NOT NULL,
    label text,
    token_encrypted text,
    CONSTRAINT shares_access_level_check CHECK ((access_level = ANY (ARRAY['view'::text, 'download'::text]))),
    CONSTRAINT shares_one_target CHECK ((((collection_id IS NOT NULL) AND (resource_id IS NULL)) OR ((collection_id IS NULL) AND (resource_id IS NOT NULL))))
);



--
-- Name: tenant_collection_access; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.tenant_collection_access (
    tenant_id uuid CONSTRAINT company_collection_access_company_id_not_null NOT NULL,
    collection_id uuid CONSTRAINT company_collection_access_collection_id_not_null NOT NULL
);



--
-- Name: tenant_role_permissions; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.tenant_role_permissions (
    tenant_id uuid NOT NULL,
    role_id integer NOT NULL,
    permission_key text NOT NULL,
    enabled boolean NOT NULL
);



--
-- Name: tenants; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.tenants (
    id uuid DEFAULT gen_random_uuid() CONSTRAINT companies_id_not_null NOT NULL,
    name text CONSTRAINT companies_name_not_null NOT NULL,
    address text,
    phone text,
    created_at timestamp with time zone DEFAULT now() CONSTRAINT companies_created_at_not_null NOT NULL
);



--
-- Name: users; Type: TABLE; Schema: public; Owner: dam
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    name text,
    status text DEFAULT 'pending'::text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tenant_id uuid,
    role_id integer DEFAULT 5 NOT NULL,
    phone text,
    can_access_all_tenants boolean DEFAULT false CONSTRAINT users_is_internal_not_null NOT NULL,
    can_invite boolean DEFAULT false NOT NULL,
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'disabled'::text])))
);



--
-- Name: metadata_fields id; Type: DEFAULT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.metadata_fields ALTER COLUMN id SET DEFAULT nextval('public.metadata_fields_id_seq'::regclass);


--
-- Name: resource_types id; Type: DEFAULT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.resource_types ALTER COLUMN id SET DEFAULT nextval('public.resource_types_id_seq'::regclass);


--
-- Data for Name: access_log; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: audit_log; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: collection_resource; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: collections; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: email_tokens; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: invitations; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: metadata_fields; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: renditions; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: resource_field_data; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: resource_types; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: resources; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: roles; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: shares; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: tenant_collection_access; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: tenant_role_permissions; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: tenants; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: dam
--



--
-- Name: metadata_fields_id_seq; Type: SEQUENCE SET; Schema: public; Owner: dam
--

SELECT pg_catalog.setval('public.metadata_fields_id_seq', 36, true);


--
-- Name: resource_types_id_seq; Type: SEQUENCE SET; Schema: public; Owner: dam
--

SELECT pg_catalog.setval('public.resource_types_id_seq', 1, false);


--
-- Name: access_log access_log_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.access_log
    ADD CONSTRAINT access_log_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: collection_resource collection_resource_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.collection_resource
    ADD CONSTRAINT collection_resource_pkey PRIMARY KEY (collection_id, resource_id);


--
-- Name: collections collections_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_pkey PRIMARY KEY (id);


--
-- Name: email_tokens email_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.email_tokens
    ADD CONSTRAINT email_tokens_pkey PRIMARY KEY (id);


--
-- Name: email_tokens email_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.email_tokens
    ADD CONSTRAINT email_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: invitations invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_pkey PRIMARY KEY (id);


--
-- Name: metadata_fields metadata_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.metadata_fields
    ADD CONSTRAINT metadata_fields_pkey PRIMARY KEY (id);


--
-- Name: renditions renditions_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.renditions
    ADD CONSTRAINT renditions_pkey PRIMARY KEY (id);


--
-- Name: renditions renditions_resource_id_kind_key; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.renditions
    ADD CONSTRAINT renditions_resource_id_kind_key UNIQUE (resource_id, kind);


--
-- Name: renditions renditions_storage_key_key; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.renditions
    ADD CONSTRAINT renditions_storage_key_key UNIQUE (storage_key);


--
-- Name: resource_field_data resource_field_data_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.resource_field_data
    ADD CONSTRAINT resource_field_data_pkey PRIMARY KEY (resource_id, field_id);


--
-- Name: resource_types resource_types_name_key; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.resource_types
    ADD CONSTRAINT resource_types_name_key UNIQUE (name);


--
-- Name: resource_types resource_types_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.resource_types
    ADD CONSTRAINT resource_types_pkey PRIMARY KEY (id);


--
-- Name: resources resources_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_pkey PRIMARY KEY (id);


--
-- Name: resources resources_storage_key_key; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_storage_key_key UNIQUE (storage_key);


--
-- Name: roles roles_name_key; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_name_key UNIQUE (name);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: shares shares_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_pkey PRIMARY KEY (id);


--
-- Name: tenant_collection_access tenant_collection_access_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.tenant_collection_access
    ADD CONSTRAINT tenant_collection_access_pkey PRIMARY KEY (tenant_id, collection_id);


--
-- Name: tenant_role_permissions tenant_role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.tenant_role_permissions
    ADD CONSTRAINT tenant_role_permissions_pkey PRIMARY KEY (tenant_id, role_id, permission_key);


--
-- Name: tenants tenants_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: idx_access_log_resource; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_access_log_resource ON public.access_log USING btree (resource_id);


--
-- Name: idx_access_log_tenant_created; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_access_log_tenant_created ON public.access_log USING btree (tenant_id, created_at);


--
-- Name: idx_audit_created; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_audit_created ON public.audit_log USING btree (created_at);


--
-- Name: idx_audit_resource; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_audit_resource ON public.audit_log USING btree (resource_id);


--
-- Name: idx_audit_user; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_audit_user ON public.audit_log USING btree (user_id);


--
-- Name: idx_collection_resource_resource; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_collection_resource_resource ON public.collection_resource USING btree (resource_id);


--
-- Name: idx_email_tokens_user; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_email_tokens_user ON public.email_tokens USING btree (user_id);


--
-- Name: idx_field_data_field; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_field_data_field ON public.resource_field_data USING btree (field_id);


--
-- Name: idx_field_data_value; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_field_data_value ON public.resource_field_data USING gin (value public.gin_trgm_ops);


--
-- Name: idx_renditions_resource; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_renditions_resource ON public.renditions USING btree (resource_id);


--
-- Name: idx_resources_creator; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_resources_creator ON public.resources USING btree (created_by);


--
-- Name: idx_resources_filename; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_resources_filename ON public.resources USING gin (original_filename public.gin_trgm_ops);


--
-- Name: idx_resources_mime; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_resources_mime ON public.resources USING btree (mime_type);


--
-- Name: idx_resources_search; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_resources_search ON public.resources USING gin (search_vector);


--
-- Name: idx_resources_status; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_resources_status ON public.resources USING btree (status);


--
-- Name: idx_resources_type; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_resources_type ON public.resources USING btree (resource_type_id);


--
-- Name: idx_shares_created_by; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_shares_created_by ON public.shares USING btree (created_by);


--
-- Name: idx_shares_revoked; Type: INDEX; Schema: public; Owner: dam
--

CREATE INDEX idx_shares_revoked ON public.shares USING btree (revoked);


--
-- Name: metadata_fields_global_name_key; Type: INDEX; Schema: public; Owner: dam
--

CREATE UNIQUE INDEX metadata_fields_global_name_key ON public.metadata_fields USING btree (name) WHERE (tenant_id IS NULL);


--
-- Name: metadata_fields_tenant_name_key; Type: INDEX; Schema: public; Owner: dam
--

CREATE UNIQUE INDEX metadata_fields_tenant_name_key ON public.metadata_fields USING btree (tenant_id, name) WHERE (tenant_id IS NOT NULL);


--
-- Name: resources trg_resources_touch; Type: TRIGGER; Schema: public; Owner: dam
--

CREATE TRIGGER trg_resources_touch BEFORE UPDATE ON public.resources FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: access_log access_log_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.access_log
    ADD CONSTRAINT access_log_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resources(id) ON DELETE SET NULL;


--
-- Name: access_log access_log_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.access_log
    ADD CONSTRAINT access_log_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;


--
-- Name: access_log access_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.access_log
    ADD CONSTRAINT access_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resources(id) ON DELETE SET NULL;


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: collection_resource collection_resource_collection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.collection_resource
    ADD CONSTRAINT collection_resource_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.collections(id) ON DELETE CASCADE;


--
-- Name: collection_resource collection_resource_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.collection_resource
    ADD CONSTRAINT collection_resource_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resources(id) ON DELETE CASCADE;


--
-- Name: collections collections_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: collections collections_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.collections
    ADD CONSTRAINT collections_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.collections(id) ON DELETE CASCADE;


--
-- Name: email_tokens email_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.email_tokens
    ADD CONSTRAINT email_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: invitations invitations_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: invitations invitations_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: invitations invitations_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.invitations
    ADD CONSTRAINT invitations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: metadata_fields metadata_fields_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.metadata_fields
    ADD CONSTRAINT metadata_fields_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: renditions renditions_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.renditions
    ADD CONSTRAINT renditions_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resources(id) ON DELETE CASCADE;


--
-- Name: resource_field_data resource_field_data_field_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.resource_field_data
    ADD CONSTRAINT resource_field_data_field_id_fkey FOREIGN KEY (field_id) REFERENCES public.metadata_fields(id) ON DELETE CASCADE;


--
-- Name: resource_field_data resource_field_data_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.resource_field_data
    ADD CONSTRAINT resource_field_data_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resources(id) ON DELETE CASCADE;


--
-- Name: resources resources_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: resources resources_resource_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.resources
    ADD CONSTRAINT resources_resource_type_id_fkey FOREIGN KEY (resource_type_id) REFERENCES public.resource_types(id);


--
-- Name: shares shares_collection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.collections(id) ON DELETE CASCADE;


--
-- Name: shares shares_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: shares shares_resource_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.shares
    ADD CONSTRAINT shares_resource_id_fkey FOREIGN KEY (resource_id) REFERENCES public.resources(id) ON DELETE CASCADE;


--
-- Name: tenant_collection_access tenant_collection_access_collection_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.tenant_collection_access
    ADD CONSTRAINT tenant_collection_access_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.collections(id) ON DELETE CASCADE;


--
-- Name: tenant_collection_access tenant_collection_access_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.tenant_collection_access
    ADD CONSTRAINT tenant_collection_access_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: tenant_role_permissions tenant_role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.tenant_role_permissions
    ADD CONSTRAINT tenant_role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: tenant_role_permissions tenant_role_permissions_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.tenant_role_permissions
    ADD CONSTRAINT tenant_role_permissions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;


--
-- Name: users users_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: users users_tenant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: dam
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);


--
-- PostgreSQL database dump complete
--

-- (removed) \unrestrict : a psql client meta-command emitted by pg_dump 18, not SQL. The pg driver cannot execute it, so scripts/migrate.mjs failed with a syntax error. Safe to drop -- it is a psql session directive, not schema.

