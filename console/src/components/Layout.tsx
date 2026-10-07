import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

export function AppLayout() {
  const { identity, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="app">
      <header className="topnav">
        <div className="topnav__inner">
          <NavLink to="/" className="brand" end>
            <span className="brand__mark" aria-hidden="true" />
            Third Place Console
          </NavLink>
          <nav className="topnav__links" aria-label="Primary">
            <NavLink to="/" end>
              Dashboard
            </NavLink>
            <NavLink to="/programs/new">New program</NavLink>
            <NavLink to="/account">Account</NavLink>
          </nav>
          <div className="topnav__user">
            {identity && (
              <NavLink to="/account" className="topnav__handle" title={identity.did}>
                @{identity.handle}
              </NavLink>
            )}
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                void signOut().then(() => navigate("/login", { replace: true }));
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}

/** Minimal chrome for the public pages linked from viewer emails. */
export function PublicLayout() {
  return (
    <div className="app app--public">
      <header className="topnav topnav--public">
        <div className="topnav__inner">
          <span className="brand">
            <span className="brand__mark" aria-hidden="true" />
            Third Place
          </span>
        </div>
      </header>
      <main className="page page--narrow">
        <Outlet />
      </main>
    </div>
  );
}
