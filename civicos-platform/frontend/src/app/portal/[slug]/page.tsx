import Portal from '@/components/civic/Portal';
export default function CommunityPage({ params }: { params: { slug: string } }) {
  return <Portal initialSlug={params.slug} />;
}
