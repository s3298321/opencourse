import type { CourseManifest, ProjectModule } from '../../src/core/types'
export function projectModule(): ProjectModule {
  return {
    type: 'project', slug: 'portfolio-project', title: 'Build a portfolio',
    project: {
      definition: 'Build a small portfolio applying the material in the course.',
      objectives: ['Practice clear structure'], estimated_minutes: 90,
      requirements: [{ id: 'content', description: 'Include a summary and two examples of your work.' }],
      deliverables: [{ id: 'portfolio', title: 'Portfolio', description: 'Provide the portfolio source and a README.', paths: ['src/portfolio.md', 'README.md'], acceptance_criteria: ['Contains a summary and two examples.', 'README explains the design choices.'] }],
      starter_files: [{ path: 'src/portfolio.md', content: '# My portfolio\n\nAdd your summary and two examples.\n' }, { path: 'README.md', content: '# Design choices\n\nDescribe your choices.\n' }]
    }
  }
}
export function projectCourse(): CourseManifest {
  return { schema_version: '1.3', slug: 'projects-demo', title: 'Project course', modules: [
    { slug: 'before', title: 'Before', lessons: [{ slug: 'intro', title: 'Introduction', blocks: [{ type: 'markdown', slug: 'prepare-your-portfolio', content: 'Prepare your portfolio.' }] }] },
    projectModule(),
    { slug: 'after', title: 'After', lessons: [{ slug: 'reflect', title: 'Reflection', blocks: [] }] }
  ] }
}
