import { createClient } from '@supabase/supabase-js';

/* ======================================================================
   ⚙️ Supabase 연결 설정
   · SUPABASE_ANON_KEY 는 브라우저에 노출되는 '공개 키'다. (설계상 정상)
     정적 export 빌드에서는 NEXT_PUBLIC_* 값이 번들에 그대로 인라인된다.
   · 회원 데이터 보호는 오직 Supabase RLS 정책으로만 이뤄진다.
     → members 테이블 정책은 반드시 'authenticated + 관리자 이메일'로 제한할 것.
       (anon 역할에 select/insert 를 열어두면 로그인 없이 전 PII가 노출된다.)
   · 공개 키이므로 아래 기본값은 소스에 그대로 둔다. 다른 프로젝트로 바꿀 때만
     .env.local 의 NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 로 덮어쓴다.
   ====================================================================== */
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://jxsdopvxtzpbyxxctcem.supabase.co';

const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4c2RvcHZ4dHpwYnl4eGN0Y2VtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyNjI3NDcsImV4cCI6MjA5ODgzODc0N30.5Uqa_RO1MxQw0CuEI2pMlTuD6zJm8NGbHoVeroFjXgI';

export const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
