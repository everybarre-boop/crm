/** @type {import('next').NextConfig} */
const nextConfig = {
  // 서버 없는 정적 export. 빌드 결과(out/)를 그대로 정적 호스팅한다.
  // 보안 모델은 기존과 동일: 브라우저가 Supabase를 직접 호출하고, RLS가 유일한 방어선이다.
  output: 'export',
  images: { unoptimized: true },
  // 정적 호스팅에서 새로고침 404를 피하기 위해 디렉터리형 경로(/path/) 사용
  trailingSlash: true,
};

export default nextConfig;
