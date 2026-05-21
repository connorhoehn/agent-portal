
package orgiq.authz

default allow := false

# Members may invoke any tool tagged sensitivity <= medium.
allow if {
    input.principal.role == "member"
    input.action == "invoke"
    input.resource.sensitivity in {"low", "medium"}
}

# Org leaders may also invoke high-sensitivity tools.
allow if {
    input.principal.role == "org-leader"
    input.action == "invoke"
}

# HR admins may discover anything.
allow if {
    input.principal.role == "hr-admin"
    input.action == "discover"
}
