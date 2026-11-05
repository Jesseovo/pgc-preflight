import { lazy, Suspense } from 'react';
import type { AdminRoute } from '../../../admin/contracts';
import { Loading, PageHeader, Tabs } from '../../components/ui';
import { useAdminRoute } from './shared';

const Models = lazy(() => import('./Models'));
const PublicData = lazy(() => import('./PublicData'));
const Uploads = lazy(() => import('./Reviews').then(module => ({ default: module.Uploads })));
const sections = [{ id: 'model', label: '模型与余额' }, { id: 'public', label: '公共资料' }, { id: 'upload', label: '手动上传' }];

export default function Settings({ route }: { route: AdminRoute }) {
  const { update } = useAdminRoute();
  const section = sections.find(item => item.id === route.section)?.id || 'model';
  return <section className="stack">
    <PageHeader eyebrow="平台维护" title="平台设置" description="维护模型、公共资料与管理员审核入口。" />
    <Tabs items={sections} value={section} onChange={value => update({ section: value })} />
    <Suspense fallback={<Loading label="正在打开设置…" />}>
      {section === 'public' ? <PublicData /> : section === 'upload' ? <Uploads /> : <Models />}
    </Suspense>
  </section>;
}
