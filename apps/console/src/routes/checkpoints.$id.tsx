import { createFileRoute, redirect } from '@tanstack/react-router'

/** The link the owner's pages carry (`<console>/checkpoints/<id>`): it lands on the item in the list. */
export const Route = createFileRoute('/checkpoints/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/needs-you', search: { item: params.id }, replace: true })
  },
})
