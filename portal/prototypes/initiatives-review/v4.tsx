import React from 'react';
import { createRoot } from 'react-dom/client';
import { DensityProvider } from '@connorhoehn/ui-components/shared';
import { Work, Sprints, Budget } from './v4-pages';
import { DispatchV4 } from './dispatch-v4';
const page=document.getElementById('review-content')!.dataset.page;
createRoot(document.getElementById('review-content')!).render(<DensityProvider density="compact">{page==='work'?<Work/>:page==='sprints'?<Sprints/>:page==='budget'?<Budget/>:<DispatchV4/>}</DensityProvider>);
