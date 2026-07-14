-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE "members" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"이름" text,
	"성별" text,
	"등록일" text,
	"생년월일" text,
	"수강권명" text,
	"수강권종류" text,
	"결제구분" text,
	"결제금액" text,
	"결제방법" text,
	"결제일시" text,
	"할부개월수" text,
	"잔여횟수" text,
	"전체횟수" text,
	"예약가능횟수" text,
	"취소가능횟수" text,
	"수강권시작일" text,
	"수강권종료일" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "admins_full_access" ON "members" AS PERMISSIVE FOR ALL TO "authenticated" USING (((auth.jwt() ->> 'email'::text) = ANY (ARRAY['basegolf.official@gmail.com'::text]))) WITH CHECK (((auth.jwt() ->> 'email'::text) = ANY (ARRAY['basegolf.official@gmail.com'::text])));
*/