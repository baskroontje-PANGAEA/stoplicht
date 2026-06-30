import dynamic from 'next/dynamic';

const Detector = dynamic(() => import('@/components/Detector'), { ssr: false });

export default function Home() {
  return <Detector />;
}
