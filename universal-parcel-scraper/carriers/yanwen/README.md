# Yanwen

The adapter signs the anonymous tracking form with the MD5 convention embedded
in the public browser script, then submits it through HTTP. The fixed browser
salt is public protocol data; no account credential, cookies or browser session
are needed.

The English result contains desktop and mobile copies. The adapter binds both
to the requested number, requires them to agree, and reads the actual dated
timeline rather than the progress rail. Each scan carries its own GMT offset.
The external link opens the official form.

Detection also selects Yanwen for the numbers of its US last-mile service: `YW`,
a hub code and twelve digits. The tracker answers such a number with its
parcel's page. The adapter accepts that page only when its identity field and
every summary copy give the number as the parcel's last-mile number, and returns
the parcel's own number as `canonical_tracking_number`.

The newest scan decides the status when the map knows its wording; the LM40
icon marks the delivery scan whatever the last-mile carrier wrote. Otherwise
the category on the identity field, which the page's status filter labels,
gives the status. In transit names no stage, because it spans customs and the
partners' legs, and a delivery still needs a delivered scan.
Information input and a label created in the seconds after Yanwen's pickup scan
are its intake, so they read as accepted rather than as an announcement.

Partner scans can start with their country's code, as in "UA.In the New Post
Office"; the map reads the words after it. A scan of the code alone names no
stage. On Nova Poshta's leg, "Delivered to customs terminal" is customs holding
the parcel, and the branch's hold ending uncollected, through storage to the
unclaimed cargo area, is an exception; its "Delivery is not possible" is the
failed attempt Yanwen's Undelivered category names.

Some relayed histories come twice: once on the local wall clock and once on
the UTC wall clock under the same offset, so their US scans read hours late. A
scan repeated with the same wording, icon and offset exactly that offset away,
in the same place or with one place missing, is the UTC copy: the adapter drops
it and the local scan keeps its place. Repeats at other intervals stay, as does
a scan that could pair with more than one other. The app scan-identity
policy lets a stored scan gain its place this way without showing twice.

A parcel bound for France gets La Poste's scans as their UTC copy alone, under
France's offset: "Arrived at destination" at 13:34:37 [GMT+02] is La Poste's
15:34:37+02:00. So when no copy was dropped, a placed scan without an icon,
under France's offset at the instant its wall clock gives in UTC, is read on
UTC's clock. Elsewhere, a scan that arrived only as its UTC copy cannot be
told apart and keeps that clock.

The parcel summary provides the last-mile reference. The notes name its
distributor and site; that carrier becomes `delivery_carrier` when the catalog
knows it and its own detection offers the reference. Contact numbers and the
customer's order number are not read. Scan locations keep the town and region
without Canadian postcodes or US ZIP codes, a partner's "Not Available" or
bare "AA" is no place, and relayed wording drops GOFO's PIN and door-number
fragments. Scans stored with such a placeholder as their place keep their row.

Run `npm run test:carriers:live -- carriers/yanwen`.
Set `YANWEN_TRACKING_NUMBER` outside the repository to check a real parcel.
