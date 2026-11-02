# Fixtures

The JSON files follow the replies of `/track/api/trackings`: `search-job.json` is a search,
listing the job asked for and an unrelated entry the search matched on another field. The others
are shipments as the tracker opens them under their service's code.

- `job-delivered.json`: an ocean job from booking to delivery, with the delivery listed twice, a
  departure without its hour and the port milestones marked actual.
- `job-in-transit.json`: an air job that has left the origin, with its arrival still estimated
  and an estimated delivery date.
- `consignment-in-transit.json`: an Australian consignment at its delivery depot, found by the
  sender's reference. Its clocks name AEST, its in-transit rows name a leg or none, and it lists
  the pickup and delivery branches.
- `consignment-delivered-us.json`: an American consignment delivered, whose scans name the
  place and ZIP code in their wording, with clocks in Central and Pacific time.
- `shipment-eu.json`: a European consignment on a 24-hour clock without a zone, with a
  rescheduled arrival day.
- `container-job.json`: a New Zealand container job through its legs to the final delivery.
- `declaration.json`: a customs declaration the tracker lists without a status or a timeline.
- `app-job.json`: the air job as Mainfreight's app opens it, with the references it carries by
  type, its master bill among them.
- `block.html`: a firewall's block page in place of a reply.

Numbers, references, names, places, postcodes, contacts, keys and clocks are invented.
